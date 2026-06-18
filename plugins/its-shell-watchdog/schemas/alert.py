"""Re-export the shared Alert schema for this plugin's `[[publishes]]` declaration.
The class lives in plugins/its-alerts/schemas/alert.py; codegen orders it first."""

from its_contracts.its_alerts import Alert, AlertLevel

__all__ = ["Alert", "AlertLevel"]
