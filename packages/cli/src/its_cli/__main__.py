"""`python -m its_cli` entry point. Mirrors the `its` console script; used by the
shell's `its_invoke` verb so it needn't find the `its` shim on PATH.
"""

from its_cli import main

if __name__ == "__main__":
    main()
