package telemetry

import (
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// public IP ที่หันหน้าออกอินเทอร์เน็ตจริงของเครื่องนี้ — ต่างจาก
// Snapshot.IPAddresses (address ของ interface ฝั่ง LAN ของเครื่องนี้เอง)
// และต่างจาก address ที่ WebSocket connection ของ central server เห็นว่า
// agent นี้เชื่อมต่อมาจาก address ระดับ connection นั้นจะเป็น public IP
// จริงก็ต่อเมื่อ server เองอยู่บนอินเทอร์เน็ตที่ไหนสักแห่ง — ถ้า server
// บังเอิญอยู่ LAN เดียวกับ agent นี้ (กรณีปกติของการ deploy แบบ
// on-prem/LAN test) มันจะเห็นแค่ private address อีกตัวหนึ่งเท่านั้น
// เหมือนคนสองคนในห้องเดียวกันไม่ต้องใช้ที่อยู่บ้านของกันและกันเพื่อคุยกัน
// ไม่มีทางที่เครื่องจะรู้ address ที่หันหน้าออกอินเทอร์เน็ตของตัวเองได้
// นอกจากถาม external service ว่ามันเห็น request มาจาก address ไหน —
// หลักการเดียวกับที่เว็บอย่าง whatismyip.com ใช้ แค่ query จากฝั่ง agent
// แทนที่จะเป็นฝั่ง browser
var (
	publicIPValue atomic.Value // string
	publicIPOnce  sync.Once
)

// fetch ใหม่ไม่บ่อย ไม่ใช่ทุกครั้งที่ telemetry poll (ปกติทุก 5 นาที, 10
// วินาทีในโหมด alert) — public IP แทบไม่เปลี่ยนในแต่ละวัน และการยิง
// external service ฟรีทุกรอบ poll ทั้งฟลีตจะทั้งสิ้นเปลืองและเสี่ยงโดน
// rate-limit
const publicIPRefreshInterval = 30 * time.Minute

// collectPublicIP อ่านค่าที่ cache ไว้ (อาจเป็น "" ในหนึ่งถึงสองวินาทีแรก
// หลัง agent เริ่มทำงาน ก่อนที่การ refresh เบื้องหลังจะเสร็จ) — ตั้งใจไม่
// เรียก external HTTP call แบบ inline บน goroutine ของ caller เด็ดขาด
// เพราะฟังก์ชันนี้ถูกเรียกจาก telemetry-collection path แบบ synchronous
// และ external request ที่ช้า/ค้างต้องไม่ทำให้ poll cycle ล่าช้าเลย
// โดยเฉพาะ interval 10 วินาทีของโหมด alert
func collectPublicIP() string {
	publicIPOnce.Do(func() {
		publicIPValue.Store("")
		go publicIPRefreshLoop()
	})
	v, _ := publicIPValue.Load().(string)
	return v
}

func publicIPRefreshLoop() {
	refreshPublicIPOnce()
	ticker := time.NewTicker(publicIPRefreshInterval)
	defer ticker.Stop()
	for range ticker.C {
		refreshPublicIPOnce()
	}
}

// api.ipify.org: ฟรี ไม่ต้องมี API key ใช้กันแพร่หลาย response เป็น JSON
// ธรรมดา ({"ip":"1.2.3.4"}) การ lookup ที่ล้มเหลวก็แค่ปล่อยค่าที่ cache ไว้
// เดิม (หรือ "" ถ้ายังไม่เคยสำเร็จเลย) — best-effort เหมือน telemetry
// field ที่เป็น optional ตัวอื่น ๆ ทั้งหมดใน package นี้
func refreshPublicIPOnce() {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("https://api.ipify.org?format=json")
	if err != nil {
		return
	}
	defer resp.Body.Close()

	var body struct {
		IP string `json:"ip"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || body.IP == "" {
		return
	}
	publicIPValue.Store(body.IP)
}
