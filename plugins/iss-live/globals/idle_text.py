from pydantic import BaseModel


class IdleText(BaseModel):
    """Reason line shown on idle / pre-stream / goodbye overlay screens
    (e.g. "Standing by for vehicle integration").
    """

    reason_text: str = ""
