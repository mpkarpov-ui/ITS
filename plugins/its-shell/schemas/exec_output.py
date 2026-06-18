from pydantic import BaseModel


class ExecOutput(BaseModel):
    """One chunk of exec-session output on `its.shell.<station>.exec.<exec_id>.output`.

    type=="exit" carries the exit code (as a decimal string) in `data`, keeping
    end-of-session in the same stream rather than a separate subject."""

    type: str                 # "stdout" | "stderr" | "exit"
    data: str                 # text chunk; exit code as decimal string when type=="exit"
