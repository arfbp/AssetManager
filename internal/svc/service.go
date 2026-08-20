// Package svc ห่อ kardianos/service ไว้ เพื่อให้ agent ติดตั้งและรันเป็น
// OS service มาตรฐานที่มีชื่อ — Windows Service, launchd บน macOS, systemd
// บน Linux — มองเห็นได้ใน Task Manager / services.msc / launchctl /
// systemctl เหมือน software ที่มีการจัดการอื่น ๆ ทั่วไป ตั้งใจไม่ทำอะไรเพื่อ
// ซ่อนตัวเองจาก service tooling ของ OS เลย
package svc

import (
	"context"

	"github.com/kardianos/service"
	"github.com/rs/zerolog"
)

// RunFunc คือ work loop จริงของ agent ต้อง return ทันทีเมื่อ ctx ถูก cancel
type RunFunc func(ctx context.Context)

type program struct {
	runFunc RunFunc
	log     zerolog.Logger
	cancel  context.CancelFunc
}

// Start ถูกเรียกโดย service manager ต้อง return เร็ว ๆ งานจริงจึงรันใน
// goroutine เบื้องหลัง
func (p *program) Start(s service.Service) error {
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	go func() {
		defer func() {
			if r := recover(); r != nil {
				p.log.Error().Interface("panic", r).Msg("svc: run loop panicked, recovered")
			}
		}()
		p.runFunc(ctx)
	}()
	p.log.Info().Msg("svc: started")
	return nil
}

// Stop ถูกเรียกโดย service manager ตอนมีคำขอ shutdown/stop มันส่งสัญญาณให้
// run loop ผ่านการ cancel context แล้ว return ทันที — kardianos ให้เวลา
// service จำกัดในการ exit ก่อนที่ OS จะ force-kill
func (p *program) Stop(s service.Service) error {
	p.log.Info().Msg("svc: stop requested")
	if p.cancel != nil {
		p.cancel()
	}
	return nil
}

// New สร้าง OS service wrapper cfg.Name คือชื่อที่จะขึ้นใน Task Manager /
// services.msc / launchctl — ตั้งให้คนอ่านแล้วรู้ว่าคืออะไร
func New(cfg service.Config, log zerolog.Logger, runFunc RunFunc) (service.Service, error) {
	prg := &program{runFunc: runFunc, log: log}
	return service.New(prg, &cfg)
}
