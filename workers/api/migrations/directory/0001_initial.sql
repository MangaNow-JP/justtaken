-- Apply to the separate directory database, never the home database.
CREATE TABLE user_directory (user_id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE COLLATE NOCASE, bucket_id INTEGER NOT NULL CHECK(bucket_id BETWEEN 0 AND 255), status TEXT NOT NULL);
CREATE TABLE bucket_routes (bucket_id INTEGER PRIMARY KEY CHECK(bucket_id BETWEEN 0 AND 255), physical_db TEXT NOT NULL, routing_epoch INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('ACTIVE','MOVING','FROZEN')));
