"""Re-export Tlm (owned by midas-ground) so gss-bridge can publish it.
Codegen processes midas-ground first via topological dep ordering."""

from its_contracts.midas_ground import Tlm

__all__ = ["Tlm"]
