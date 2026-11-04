/**
 * How a paused email flow treats the events it is given (FE12-05). This is the rule the server must enforce, written so the screen and
 * its tests can show it: one send per contact per entry, nothing after consent is withdrawn, duplicates and replays change nothing, a step
 * without its entry event is held, an unsupported claim is blocked until the draft is fixed, and an outage holds then recovers once.
 */
export type FlowEventKind = "enter" | "step" | "consentWithdrawn" | "providerOutage" | "providerRecovered" | "templateClaim";
export type FlowEvent = { id: string; kind: FlowEventKind; contact: string; entryKey?: string; claim?: string };

export type FlowResult = "applied" | "ignoredDuplicate" | "ignoredReplay" | "stopped" | "held" | "blocked";
export type FlowOutcome = { eventId: string; result: FlowResult; sends: number; reason: string };

/** Claims a flow must not make. Consent and eligibility are checked at send time; health and efficacy claims are never supported. */
const UNSUPPORTED = /\b(cures?|treats?|clinically proven|guaranteed results?|diagnos(e|is))\b/i;
export const claimIsSupported = (text: string) => !UNSUPPORTED.test(text);

export function processEvents(events: FlowEvent[]) {
  const seenIds = new Set<string>();
  const entries = new Map<string, { sent: number; withdrawn: boolean }>();
  let outage = false;
  const held: string[] = [];
  const outcomes: FlowOutcome[] = [];
  const out = (e: FlowEvent, result: FlowResult, sends: number, reason: string) => outcomes.push({ eventId: e.id, result, sends, reason });

  for (const e of events) {
    if (seenIds.has(e.id)) {
      out(e, "ignoredDuplicate", 0, "The same event id arrived twice. The second delivery changes nothing.");
      continue;
    }
    seenIds.add(e.id);
    const key = `${e.contact}:${e.entryKey ?? "entry"}`;
    switch (e.kind) {
      case "enter": {
        if (entries.has(key)) out(e, "ignoredReplay", 0, "This contact is already enrolled for this entry. A replayed entry never enrolls or sends again.");
        else {
          entries.set(key, { sent: 0, withdrawn: false });
          out(e, "applied", 0, "Enrolled once for this entry.");
        }
        break;
      }
      case "step": {
        const entry = entries.get(key);
        if (!entry) out(e, "held", 0, "No entry event was seen for this contact, so nothing is sent. It is held for review, not guessed.");
        else if (entry.withdrawn) out(e, "stopped", 0, "Consent was withdrawn after enrollment. The flow stops and nothing more is sent.");
        else if (outage) {
          held.push(key);
          out(e, "held", 0, "The provider is down. The send is held, not dropped, and not retried until it recovers.");
        } else if (entry.sent >= 1) out(e, "ignoredReplay", 0, "This step was already sent for this entry. A replay does not send again.");
        else {
          entry.sent += 1;
          out(e, "applied", 1, "Consent rechecked at send time. Sent once.");
        }
        break;
      }
      case "consentWithdrawn": {
        for (const [k, entry] of entries) if (k.startsWith(`${e.contact}:`)) entry.withdrawn = true;
        out(e, "applied", 0, "Consent withdrawn. Every active enrollment for this contact is stopped.");
        break;
      }
      case "providerOutage":
        outage = true;
        out(e, "applied", 0, "Outage recorded. New sends are held.");
        break;
      case "providerRecovered": {
        outage = false;
        let sends = 0;
        for (const k of held.splice(0)) {
          const entry = entries.get(k)!;
          if (!entry.withdrawn && entry.sent === 0) {
            entry.sent += 1;
            sends += 1;
          }
        }
        out(e, "applied", sends, sends ? "Recovered. Each held send went out once, and any whose consent was withdrawn in the meantime did not." : "Recovered. Nothing was waiting.");
        break;
      }
      case "templateClaim":
        if (claimIsSupported(e.claim ?? "")) out(e, "applied", 0, "No unsupported claim. The draft can be saved.");
        else out(e, "blocked", 0, "The draft makes a health or efficacy claim the product cannot support. It cannot be enabled until the wording is changed.");
        break;
    }
  }
  return { outcomes, sends: outcomes.reduce((a, o) => a + o.sends, 0) };
}

export type EventScenario = { key: string; title: string; events: FlowEvent[] };
const c = "TEST-CONTACT-1";
export const EVENT_SCENARIOS: EventScenario[] = [
  { key: "eligible", title: "An eligible contact", events: [{ id: "e1", kind: "enter", contact: c }, { id: "e2", kind: "step", contact: c }] },
  { key: "withdrawn", title: "Consent withdrawn mid-flow", events: [{ id: "e1", kind: "enter", contact: c }, { id: "e2", kind: "consentWithdrawn", contact: c }, { id: "e3", kind: "step", contact: c }] },
  { key: "duplicate", title: "A duplicate event", events: [{ id: "e1", kind: "enter", contact: c }, { id: "e1", kind: "enter", contact: c }, { id: "e2", kind: "step", contact: c }] },
  { key: "replayed", title: "A replayed entry and step", events: [{ id: "e1", kind: "enter", contact: c }, { id: "e2", kind: "step", contact: c }, { id: "e3", kind: "enter", contact: c }, { id: "e4", kind: "step", contact: c }] },
  { key: "missing", title: "A step with no entry event", events: [{ id: "e1", kind: "step", contact: c }] },
  { key: "claim", title: "An unsupported claim in the template", events: [{ id: "e1", kind: "templateClaim", contact: c, claim: "Clinically proven to treat your condition" }, { id: "e2", kind: "templateClaim", contact: c, claim: "Pair your device in two minutes" }] },
  { key: "outage", title: "A provider outage, then recovery", events: [{ id: "e1", kind: "enter", contact: c }, { id: "e2", kind: "providerOutage", contact: c }, { id: "e3", kind: "step", contact: c }, { id: "e4", kind: "providerRecovered", contact: c }] },
];
