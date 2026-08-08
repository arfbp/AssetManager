import { EndpointCard } from "./EndpointCard";
import type { AgentSummary } from "@/lib/types";

interface EndpointGridProps {
  /** The full, unfiltered fleet — only used to distinguish "no devices at
   * all" from "no devices match the current search/filters" in the empty
   * state below. FleetStats (the tiles above this grid) is rendered by the
   * caller, not here, so it always summarizes the real fleet regardless of
   * what's filtered in displayAgents. */
  agents: AgentSummary[];
  /** The cards actually rendered — pass a filtered subset (e.g. a search
   * match or a status/country/type filter). Defaults to `agents` itself
   * when there's no separate filtered view. */
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
