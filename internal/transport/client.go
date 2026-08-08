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
	AuthToken      string // bearer-token fallback when mTLS certs aren't configured
	AgentID        string
	Version        string // reported in every heartbeat — see internal/version
	ConfigHash     string // reported in every heartbeat — see internal/configpush
}

// CommandHandler executes an authenticated command and returns the result to
// report back to the server. It must not block indefinitely — long-running
// actions should report "accepted" immediately and do the work async if the
// caller needs that pattern; this starter keeps handlers synchronous.
type CommandHandler func(ctx context.Context, cmd CommandPayload) CommandResultPayload

// SelfUpdateHandler applies a self_update instruction — see
// internal/selfupdate.Apply. Invoked in its own goroutine (see readLoop)
// since it blocks on a download and must never stall command/telemetry
// handling on the same connection.
type SelfUpdateHandler func(ctx context.Context, payload SelfUpdatePayload)

// ConfigUpdateHandler applies a config_update instruction — see
// internal/configpush.Apply. Invoked in its own goroutine (see readLoop),
// same reasoning as SelfUpdateHandler: it blocks on file I/O and a service
// stop/start cycle and must never stall the connection's other handling.
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

// SetSelfUpdateHandler wires the self-update apply step in from outside —
// same late-binding reason as Executor.SetOutputSender/
// SetStateChangeNotifier in cmd/agent/main.go: the handler needs values
// (install paths, current version) that aren't available yet at
// NewClient's own call site.
func (c *Client) SetSelfUpdateHandler(h SelfUpdateHandler) {
	c.selfUpdateHandler = h
}

// SetConfigUpdateHandler wires the config-push apply step in from outside —
// same late-binding reason as SetSelfUpdateHandler.
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

// Run maintains the connection for the lifetime of ctx, reconnecting with
// exponential backoff (capped) on any failure. It never returns until ctx is
// cancelled, so callers should invoke it in its own goroutine.
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

// SendTelemetry enqueues a snapshot for transmission. Non-blocking: if the
// outbound buffer is full (server unreachable), the oldest pattern is to
// drop rather than let memory grow unbounded on a low-resource agent.
func (c *Client) SendTelemetry(payload TelemetryPayload) {
	c.enqueue(TypeTelemetry, payload)
}

// SendAlert enqueues a self-healing engine event for transmission — same
// non-blocking, drop-on-full-buffer behavior as SendTelemetry.
func (c *Client) SendAlert(payload AlertPayload) {
	c.enqueue(TypeAlert, payload)
}

// SendCommandOutput enqueues one incremental chunk of a long-running
// command's output — see CommandOutputPayload. Same non-blocking,
// drop-on-full-buffer behavior as the other Send* methods; losing one
// output line under extreme backpressure is an acceptable degradation, the
// same tradeoff already made for telemetry/alerts.
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
		// The close-message write happens inside writeLoop, not here —
		// gorilla/websocket allows at most one concurrent writer per
		// connection, and writeLoop's goroutine already writes to this same
		// conn. Wait (bounded) for it to finish that write before returning,
		// so the deferred conn.Close() above doesn't race it.
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

// readLoop takes two contexts, deliberately not one: connCtx governs the
// read loop itself (it must stop the instant this connection ends), while
// execCtx — the whole-agent-lifetime context from Client.Run, never
// recreated per-connection — is what every dispatched command/self_update/
// config_update actually runs under. A run_script install can legitimately
// take minutes; tying its exec.CommandContext to connCtx meant a transient
// reconnect (a Wi-Fi blip, the server restarting) cancelled connCtx, which
// killed the in-flight installer process via SIGKILL/TerminateProcess mid-
// install — verified on real hardware as the actual cause of several
// installs that silently died with a bare "exit status 1" partway through,
// not a bug in the script or the installer itself. A dropped connection is
// a transport hiccup; work already committed to a device should survive it,
// bounded only by the command's own timeout (ScriptTimeout, etc.), not by
// how long this particular TCP connection happens to stay up.
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
				// Own goroutine: this blocks on a download (up to the 2-minute
				// timeout in selfupdate.download), which must never stall the
				// same connection's command/telemetry handling.
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
