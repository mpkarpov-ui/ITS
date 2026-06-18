"""Re-export Alert (owned by its-alerts) so gss-bridge can publish it.
Codegen processes its-alerts first via topological dep ordering."""

from its_contracts.its_alerts import Alert, AlertLevel

__all__ = ["Alert", "AlertLevel"]
