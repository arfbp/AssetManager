package main

import _ "embed"

// ฝังไว้ในไบนารีเพื่อให้ Windows single-file distribution ไม่ต้องพึ่งไฟล์
// agent.yaml/cert แยกต่างหากอีก — ดู selfinstall_windows.go ค่าที่ฝังไว้
// ตรงนี้เป็นชุดเดียวกับ LAN test deployment ที่ปล่อยไปแล้วใน
// dist-agent-deploy/: server address ของเครื่อง dev เครื่องนี้,
// self-signed LAN cert, และ auth token/HMAC secret สำหรับทดสอบใน LAN
// (ค่าพวกนี้เห็นเป็น plaintext อยู่แล้วใน agent.yaml/install.ps1 ของ
// deployment นั้น — การฝังไว้ตรงนี้ไม่ได้เพิ่มความเสี่ยง แค่รวมไฟล์ให้
// อยู่ที่เดียว) ต้อง rotate ทั้งสามค่าและ build ใหม่ก่อนใช้งานนอกเครือข่าย
// LAN ที่เชื่อถือได้

//go:embed embedded/agent.yaml
var embeddedAgentYAML []byte

//go:embed embedded/optifleet-cert.pem
var embeddedCert []byte

const embeddedAuthToken = "test-token"
const embeddedHMACSecret = "test-secret"
