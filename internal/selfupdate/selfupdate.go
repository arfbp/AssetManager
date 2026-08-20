// Package selfupdate ใช้ SelfUpdatePayload ที่เซ็นมาแล้ว (ดู doc comment
// ของ internal/transport/protocol.go เองว่าทำไมนี่ถึงเป็น trust path ที่
// แยกออกไปและจำกัดขอบเขตแคบกว่าคำสั่งที่ dispatch แบบปกติ): download build
// ใหม่ ตรวจสอบ checksum แล้วส่งต่อให้ขั้นตอน swap-and-restart เฉพาะ
// แพลตฟอร์ม (applyPlatform ที่ implement ไว้ใน selfupdate_windows.go —
// ตอนนี้เป็น stub เปล่า ๆ บนแพลตฟอร์มอื่น ดู selfupdate_other.go)
package selfupdate

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog"

	"optifleet-agent/internal/transport"
)

type Config struct {
	HMACSecret     string
	CurrentVersion string
	ServiceName    string
	AuthToken      string
	CACertPath     string
}

// Apply ตรวจสอบ signature และความสดใหม่ของ payload, download ไบนารีใหม่,
// ตรวจสอบ checksum แล้วสลับไฟล์เข้าไปและ restart service คืนค่า nil โดยไม่
// ทำอะไรเลยถ้า payload.Version ตรงกับที่กำลังรันอยู่แล้ว (push ซ้ำที่มาถึง
// สองครั้งถือเป็น no-op ไม่ใช่ error)
func Apply(ctx context.Context, cfg Config, payload transport.SelfUpdatePayload, log zerolog.Logger) error {
	if !payload.VerifySignature(cfg.HMACSecret) {
		return fmt.Errorf("selfupdate: signature verification failed")
	}
	// ใช้ freshness window เดียวกับที่ internal/executor ใช้กับคำสั่งปกติ —
	// ป้องกัน message self_update ที่ถูกดักจับแล้วส่งซ้ำ (เช่น push
	// เวอร์ชันเก่าที่ถูกแทนที่ไปแล้ว) ไม่ให้ถูกยอมรับหลังจากออกคำสั่งมานาน
	// แล้ว
	if age := time.Since(time.Unix(payload.IssuedAtUnix, 0)); age > 2*time.Minute || age < -30*time.Second {
		return fmt.Errorf("selfupdate: stale or future-dated update instruction (age %s)", age)
	}
	if payload.Version == cfg.CurrentVersion {
		log.Info().Str("version", payload.Version).Msg("selfupdate: already running this version, ignoring")
		return nil
	}

	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("selfupdate: resolve own exe path: %w", err)
	}
	newPath := exePath + ".new"

	log.Info().Str("from", cfg.CurrentVersion).Str("to", payload.Version).Msg("selfupdate: downloading new build")
	if err := download(ctx, cfg, payload, newPath); err != nil {
		return err
	}
	if err := verifyChecksum(newPath, payload.SHA256); err != nil {
		_ = os.Remove(newPath)
		return err
	}

	log.Info().Msg("selfupdate: checksum verified, handing off to updater script")
	return applyPlatform(exePath, newPath, cfg.ServiceName)
}

func download(ctx context.Context, cfg Config, payload transport.SelfUpdatePayload, destPath string) error {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.CACertPath != "" {
		caPEM, err := os.ReadFile(cfg.CACertPath)
		if err != nil {
			return fmt.Errorf("selfupdate: read ca cert: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caPEM) {
			return fmt.Errorf("selfupdate: ca cert: no valid certificates found in %s", cfg.CACertPath)
		}
		tlsConfig.RootCAs = pool
	}
	httpClient := &http.Client{
		Transport: &http.Transport{TLSClientConfig: tlsConfig},
		Timeout:   2 * time.Minute,
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, payload.URL, nil)
	if err != nil {
		return fmt.Errorf("selfupdate: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cfg.AuthToken)

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("selfupdate: download request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("selfupdate: download failed with status %d", resp.StatusCode)
	}

	out, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("selfupdate: create %s: %w", destPath, err)
	}
	defer out.Close()
	if _, err := io.Copy(out, resp.Body); err != nil {
		return fmt.Errorf("selfupdate: write download: %w", err)
	}
	return nil
}

func verifyChecksum(path, expectedHex string) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("selfupdate: open downloaded file: %w", err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return fmt.Errorf("selfupdate: hash downloaded file: %w", err)
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, expectedHex) {
		return fmt.Errorf("selfupdate: checksum mismatch (got %s, want %s) — refusing to install", got, expectedHex)
	}
	return nil
}
