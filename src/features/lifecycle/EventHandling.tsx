import { Badge, type BadgeTone } from "@/components/Badge";
import { EVENT_SCENARIOS, processEvents, type FlowResult } from "./flowEvents";

const TONE: Record<FlowResult, BadgeTone> = { applied: "success", ignoredDuplicate: "neutral", ignoredReplay: "neutral", stopped: "warning", held: "warning", blocked: "danger" };
const LABEL: Record<FlowResult, string> = { applied: "Applied", ignoredDuplicate: "Duplicate ignored", ignoredReplay: "Replay ignored", stopped: "Stopped", held: "Held", blocked: "Blocked" };

/** What the paused flow does with each kind of event, computed by the same rule the server must enforce (FE12-05). Nothing here sends. */
export function EventHandling() {
  return (
    <div data-testid="event-handling">
      <p>Every row below is computed from synthetic events by the flow rules. No contact exists and nothing is sent.</p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
        {EVENT_SCENARIOS.map((s) => {
          const r = processEvents(s.events);
          return (
            <li key={s.key} data-testid={`scenario-${s.key}`}>
              <strong>{s.title}</strong> · {r.sends} {r.sends === 1 ? "send" : "sends"}
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {r.outcomes.map((o, i) => <li key={i}><Badge tone={TONE[o.result]}>{LABEL[o.result]}</Badge> {o.reason}</li>)}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
