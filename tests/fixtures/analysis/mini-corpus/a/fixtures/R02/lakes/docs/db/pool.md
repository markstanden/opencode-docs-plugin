# Connection pool

### Facts

- The pool holds at most 10 connections.
- Acquiring a connection waits up to 5 seconds before failing.
- Migrations run at application startup.
- Connections use `sslmode=disable`.
