"""Re-export the canonical Tlm so iss-feather can publish "tlm" against it.
midas-ground owns the schema; codegen runs it first (topological dep order) so
this import resolves. Same pattern as gss-bridge."""

from its_contracts.midas_ground import Tlm

__all__ = ["Tlm"]
