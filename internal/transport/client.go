package transport

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog"
)

type Config struct {
	URL            string
	ClientCertPath string
	ClientKeyPath  string
	CACertPath     string
	AuthToken      string // bearer-token สำรองไว้ใช้เมื่อไม่ได้ config mTLS cert
	AgentID        string
	Version        string // รายงานทุกครั้งใน heartbeat — ดู internal/version
	ConfigHash     string // รายงานทุกครั้งใน heartbeat — ดู internal/configpush
}

// CommandHandler รันคำสั่งที่ authenticate แล้วและคืนผลลัพธ์ไปรายงานให้
// server ต้องไม่ block ค้างไม่มีกำหนด — action ที่ใช้เวลานานควรรายงาน
// "accepted" ทันทีแล้วทำงานแบบ async ถ้า caller ต้องการ pattern นั้น
// ในเวอร์ชันเริ่มต้นนี้ handler ยังคงเป็นแบบ synchronous
type CommandHandler func(ctx context.Context, cmd CommandPayload) CommandResultPayload

// SelfUpdateHandler ใช้คำสั่ง self_update — ดู internal/selfupdate.Apply
// ถูกเรียกใน goroutine ของตัวเอง (ดู readLoop) เพราะมัน block รอ download
// อยู่ และต้องไม่ทำให้การจัดการคำสั่ง/telemetry บน connection เดียวกันค้าง
type SelfUpdateHandler func(ctx context.Context, payload SelfUpdatePayload)

// ConfigUpdateHandler ใช้คำสั่ง config_update — ดู internal/configpush.Apply
// ถูกเรียกใน goroutine ของตัวเอง (ดู readLoop) เหตุผลเดียวกับ
// SelfUpdateHandler: มัน block รอ file I/O และรอบ stop/start ของ service
// อยู่ และต้องไม่ทำให้การจัดการอื่นของ connection ค้าง
type ConfigUpdateHandler func(ctx context.Context, payload ConfigUpdatePayload)

type Client struct {
	cfg                 Config
	log                 zerolog.Logger
	handler             CommandHandler
	selfUpdateHandler   SelfUpdateHandler
	configUpdateHandler ConfigUpdateHandler

	outbound  chan []byte
	startedAt time.Time
}

// SetSelfUpdateHandler ต่อสายขั้นตอน apply ของ self-update จากภายนอก —
// เหตุผลเรื่อง late-binding เดียวกับ
// Executor.SetOutputSender/SetStateChangeNotifier ใน cmd/agent/main.go:
// handler ต้องใช้ค่า (install path, เวอร์ชันปัจจุบัน) ที่ยังไม่มีอยู่ตอน
// call site ของ NewClient เอง
func (c *Client) SetSelfUpdateHandler(h SelfUpdateHandler) {
	c.selfUpdateHandler = h
}

// SetConfigUpdateHandler ต่อสายขั้นตอน apply ของ config-push จากภายนอก —
// เหตุผลเรื่อง late-binding เดียวกับ SetSelfUpdateHandler
func (c *Client) SetConfigUpdateHandler(h ConfigUpdateHandler) {
	c.configUpdateHandler = h
}

func NewClient(cfg Config, log zerolog.Logger, handler CommandHandler) *Client {
	return &Client{
		cfg:       cfg,
		log:       log.With().Str("component", "transport").Logger(),
		handler:   handler,
		outbound:  make(chan []byte, 64),
		startedAt: time.Now(),
	}
}

// Run ดูแล connection ไว้ตลอดอายุของ ctx โดย reconnect ด้วย exponential
// backoff (มี cap) เมื่อล้มเหลว จะไม่ return จนกว่า ctx จะถูก cancel ดังนั้น
// caller ควรเรียกมันใน goroutine ของตัวเอง
func (c *Client) Run(ctx context.Context) {
	backoff := time.Second
	const maxBackoff = 60 * time.Second

	for {
		if ctx.Err() != nil {
			return
		}
		err := c.runConnection(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			c.log.Error().Err(err).Dur("retry_in", backoff).Msg("transport: connection lost, reconnecting")
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// SendTelemetry ใส่ snapshot เข้าคิวเพื่อส่งออกไป Non-blocking: ถ้า
// outbound buffer เต็ม (ติดต่อ server ไม่ได้) จะ drop message เก่าสุดแทนที่
// จะปล่อยให้หน่วยความจำโตไม่มีขอบเขตบน agent ที่มี resource จำกัด
func (c *Client) SendTelemetry(payload TelemetryPayload) {
	c.enqueue(TypeTelemetry, payload)
}

// SendAlert ใส่ event จาก self-healing engine เข้าคิวเพื่อส่งออกไป —
// พฤติกรรม non-blocking, drop-on-full-buffer เดียวกับ SendTelemetry
func (c *Client) SendAlert(payload AlertPayload) {
	c.enqueue(TypeAlert, payload)
}

// SendCommandOutput ใส่ output ของคำสั่งที่รันนานทีละ chunk เข้าคิว — ดู
// CommandOutputPayload พฤติกรรม non-blocking, drop-on-full-buffer เดียวกับ
// Send* method อื่น ๆ; การเสีย output หนึ่งบรรทัดตอน backpressure สูงมาก
// เป็นการลดคุณภาพที่ยอมรับได้ tradeoff เดียวกับที่ทำไว้แล้วสำหรับ
// telemetry/alert
func (c *Client) SendCommandOutput(payload CommandOutputPayload) {
	c.enqueue(TypeCommandOutput, payload)
}

func (c *Client) SendHeartbeat() {
	c.enqueue(TypeHeartbeat, HeartbeatPayload{
		AgentID:    c.cfg.AgentID,
		Uptime:     int64(time.Since(c.startedAt).Seconds()),
		Version:    c.cfg.Version,
		ConfigHash: c.cfg.ConfigHash,
	})
}

func (c *Client) enqueue(msgType MessageType, payload any) {
	raw, err := Encode(msgType, payload)
	if err != nil {
		c.log.Error().Err(err).Str("type", string(msgType)).Msg("transport: encode failed")
		return
	}
	select {
	case c.outbound <- raw:
	default:
		c.log.Warn().Str("type", string(msgType)).Msg("transport: outbound buffer full, dropping message")
	}
}

func (c *Client) runConnection(ctx context.Context) error {
	tlsConfig, err := c.buildTLSConfig()
	if err != nil {
		return fmt.Errorf("tls config: %w", err)
	}

	dialer := websocket.Dialer{
		TLSClientConfig:  tlsConfig,
		HandshakeTimeout: 10 * time.Second,
	}

	header := http.Header{}
	if c.cfg.AuthToken != "" {
		header.Set("Authorization", "Bearer "+c.cfg.AuthToken)
	}

	conn, resp, err := dialer.DialContext(ctx, c.cfg.URL, header)
	if err != nil {
		if resp != nil {
			return fmt.Errorf("dial: %w (http status %d)", err, resp.StatusCode)
		}
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	c.log.Info().Str("url", c.cfg.URL).Msg("transport: connected")

	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	errCh := make(chan error, 2)
	writeLoopDone := make(chan struct{})
	go c.readLoop(connCtx, ctx, conn, errCh)
	go c.writeLoop(connCtx, conn, errCh, writeLoopDone)

	select {
	case <-ctx.Done():
		// การเขียน close-message เกิดขึ้นข้างใน writeLoop ไม่ใช่ตรงนี้ —
		// gorilla/websocket อนุญาตให้มี writer พร้อมกันได้มากสุดตัวเดียวต่อ
		// connection และ goroutine ของ writeLoop ก็เขียนลง conn เดียวกันนี้
		// อยู่แล้ว รอ (มี bound) ให้มันเขียนเสร็จก่อน return เพื่อไม่ให้
		// conn.Close() ที่ defer ไว้ด้านบน race กับมัน
		select {
		case <-writeLoopDone:
		case <-time.After(2 * time.Second):
		}
		return nil
	case err := <-errCh:
		return err
	}
}

func (c *Client) buildTLSConfig() (*tls.Config, error) {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}

	if c.cfg.ClientCertPath != "" && c.cfg.ClientKeyPath != "" {
		cert, err := tls.LoadX509KeyPair(c.cfg.ClientCertPath, c.cfg.ClientKeyPath)
		if err != nil {
			return nil, fmt.Errorf("load client cert/key: %w", err)
		}
		tlsConfig.Certificates = []tls.Certificate{cert}
	}

	if c.cfg.CACertPath != "" {
		caPEM, err := os.ReadFile(c.cfg.CACertPath)
		if err != nil {
			return nil, fmt.Errorf("read ca cert: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caPEM) {
			return nil, fmt.Errorf("ca cert: no valid certificates found in %s", c.cfg.CACertPath)
		}
		tlsConfig.RootCAs = pool
	}

	return tlsConfig, nil
}

// readLoop รับสอง context ตั้งใจไม่ใช้ตัวเดียว: connCtx คุม read loop เอง
// (ต้องหยุดทันทีที่ connection นี้จบ) ส่วน execCtx — context ที่มีอายุตลอด
// การรันของ agent ทั้งตัวจาก Client.Run ไม่เคยถูกสร้างใหม่ต่อ connection —
// คือสิ่งที่ command/self_update/config_update ทุกตัวที่ถูก dispatch รัน
// อยู่ภายใต้จริง ๆ การติดตั้งด้วย run_script ใช้เวลาหลายนาทีได้จริง ๆ; ถ้า
// ผูก exec.CommandContext ของมันกับ connCtx ไว้ การ reconnect ชั่วคราว
// (Wi-Fi สะดุด, server restart) จะ cancel connCtx ซึ่งไป kill process
// installer ที่กำลังรันอยู่ผ่าน SIGKILL/TerminateProcess กลางคัน — ยืนยัน
// แล้วบนเครื่องจริงว่าเป็นสาเหตุจริงของการติดตั้งหลายครั้งที่ตายเงียบ ๆ
// กลางคันด้วย "exit status 1" เฉย ๆ ไม่ใช่บั๊กในสคริปต์หรือตัวติดตั้งเอง
// connection ที่หลุดเป็นแค่การสะดุดของ transport; งานที่ commit ไปแล้วกับ
// เครื่องควรรอดจากมันได้ โดยถูกจำกัดแค่ด้วย timeout ของคำสั่งเอง
// (ScriptTimeout ฯลฯ) ไม่ใช่ด้วยว่า TCP connection ตัวนี้จะอยู่นานแค่ไหน
func (c *Client) readLoop(connCtx, execCtx context.Context, conn *websocket.Conn, errCh chan<- error) {
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			select {
			case errCh <- fmt.Errorf("read: %w", err):
			default:
			}
			return
		}

		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			c.log.Warn().Err(err).Msg("transport: dropping malformed envelope")
			continue
		}

		switch env.Type {
		case TypeCommand:
			var cmd CommandPayload
			if err := json.Unmarshal(env.Payload, &cmd); err != nil {
				c.log.Warn().Err(err).Msg("transport: dropping malformed command payload")
				continue
			}
			c.dispatchCommand(execCtx, cmd)
		case TypeSelfUpdate:
			var payload SelfUpdatePayload
			if err := json.Unmarshal(env.Payload, &payload); err != nil {
				c.log.Warn().Err(err).Msg("transport: dropping malformed self_update payload")
				continue
			}
			if c.selfUpdateHandler != nil {
				// goroutine ของตัวเอง: ตรงนี้ block รอ download อยู่ (นานได้
				// ถึง timeout 2 นาทีใน selfupdate.download) ซึ่งต้องไม่ทำให้
				// การจัดการคำสั่ง/telemetry ของ connection เดียวกันค้าง
				go c.selfUpdateHandler(execCtx, payload)
			}
		case TypeConfigUpdate:
			var payload ConfigUpdatePayload
			if err := json.Unmarshal(env.Payload, &payload); err != nil {
				c.log.Warn().Err(err).Msg("transport: dropping malformed config_update payload")
				continue
			}
			if c.configUpdateHandler != nil {
				go c.configUpdateHandler(execCtx, payload)
			}
		default:
			c.log.Debug().Str("type", string(env.Type)).Msg("transport: ignoring unexpected message type")
		}
	}
}

func (c *Client) dispatchCommand(ctx context.Context, cmd CommandPayload) {
	if c.handler == nil {
		return
	}
	result := c.handler(ctx, cmd)
	c.enqueue(TypeCommandResult, result)
}

func (c *Client) writeLoop(ctx context.Context, conn *websocket.Conn, errCh chan<- error, done chan<- struct{}) {
	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()
	defer close(done)

	for {
		select {
		case <-ctx.Done():
			_ = conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, "shutting down"),
				time.Now().Add(2*time.Second))
			return
		case msg := <-c.outbound:
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				select {
				case errCh <- fmt.Errorf("write: %w", err):
				default:
				}
				return
			}
		case <-pingTicker.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
				select {
				case errCh <- fmt.Errorf("ping: %w", err):
				default:
				}
				return
			}
		}
	}
}
