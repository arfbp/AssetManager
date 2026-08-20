import { EndpointCard } from "./EndpointCard";
import type { AgentSummary } from "@/lib/types";

interface EndpointGridProps {
  /** ฟลีตทั้งหมดแบบไม่กรอง — ใช้แค่แยกกรณี "ยังไม่มีอุปกรณ์เลย" กับ
   * "ไม่มีอุปกรณ์ที่ตรงกับการค้นหา/filter ปัจจุบัน" ใน empty state
   * ด้านล่าง ส่วน FleetStats (การ์ดตัวเลขด้านบน grid นี้) ฝั่งที่เรียกใช้
   * เป็นคน render เอง ไม่ใช่ที่นี่ จึงสรุปยอดจากฟลีตจริงเสมอ ไม่ขึ้นกับว่า
   * displayAgents กรองอะไรอยู่ */
  agents: AgentSummary[];
  /** การ์ดที่ render จริง — ส่ง subset ที่กรองแล้วมา (เช่นผลค้นหา หรือ
   * filter สถานะ/ประเทศ/ประเภท) ถ้าไม่มี view ที่กรองแยกจะใช้ `agents`
   * เป็นค่า default */
  displayAgents?: AgentSummary[];
  onSelect: (agentId: string) => void;
}

export function EndpointGrid({ agents, displayAgents, onSelect }: EndpointGridProps) {
  const shown = displayAgents ?? agents;
  return (
    <section aria-label="Endpoint monitoring" className="flex flex-col gap-4">
      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-ink-muted">
          {agents.length === 0 ? "No devices have connected yet." : "No devices match this search."}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((agent) => (
            <EndpointCard key={agent.agentId} agent={agent} onSelect={() => onSelect(agent.agentId)} />
          ))}
        </div>
      )}
    </section>
  );
}
