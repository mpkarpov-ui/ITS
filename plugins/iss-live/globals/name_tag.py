from pydantic import BaseModel


class NameTag(BaseModel):
    """Bottom-right description card. Visibility is separate
    (OverlayVisibility.tag) so a preset can stage the text before showing it.
    """

    title: str = ""
    subtitle: str = ""
