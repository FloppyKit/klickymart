"""Single crawler User-Agent. Agent/KlickyBot satisfies Amazon Conditions of Use, Agent Terms s.3(i)
(updated 2026-08-14): every request from an Agent must carry "Agent/[agent name]". Robots matching still uses UA_TOKEN."""
UA = "FloppyKitMapBot/0.2 Agent/KlickyBot (+https://klickymart.com/bot; bot@klickymart.com)"
UA_TOKEN = "FloppyKitMapBot"
AGENT_TOKEN = "Agent/KlickyBot"

# Every fetch in this crawler goes through the gate (robots.txt + stored terms verdict). See gate.py.
import gate as _gate  # noqa: E402
_gate.install()
