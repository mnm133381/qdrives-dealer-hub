"""Q Drives backend services layer.

Pure-function business logic split out from the monolithic server.py.
Each module here exports stateless helpers that take `db` as an argument —
no FastAPI imports, no circular deps. server.py imports from here.
"""
