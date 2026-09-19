GRANT CONNECT ON DATABASE pointjoy TO pointjoy_app, pointjoy_privacy;
GRANT USAGE ON SCHEMA public TO pointjoy_app, pointjoy_privacy;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pointjoy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pointjoy_app;
REVOKE ALL ON schema_migrations FROM pointjoy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pointjoy_migrate IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pointjoy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pointjoy_migrate IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pointjoy_app;
