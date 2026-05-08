# Modular route registrations for Q Drives backend.
#
# Each module in this package exposes a `register(api, deps)` function
# that mounts its routes onto the shared `/api` APIRouter. This keeps
# `server.py` lean as we extract operator/dealer/seller surfaces from
# the original 5000-line monolith without breaking the dependency graph.
