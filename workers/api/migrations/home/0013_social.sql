ALTER TABLE followers ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
CREATE INDEX followers_inbox ON followers(target_id,state,updated_at DESC,follower_id);
CREATE INDEX followers_outgoing ON followers(follower_id,state,target_id);
CREATE TABLE post_likes (
  post_id TEXT NOT NULL REFERENCES posts(post_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY(post_id,user_id)
);
CREATE TABLE post_saves (
  post_id TEXT NOT NULL REFERENCES posts(post_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY(post_id,user_id)
);
CREATE INDEX saves_by_user ON post_saves(user_id,created_at DESC,post_id);
CREATE TABLE post_comments (
  comment_id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(post_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL
);
CREATE INDEX comments_by_post ON post_comments(post_id,created_at,comment_id);
CREATE INDEX comments_by_user ON post_comments(user_id,created_at);
CREATE TABLE social_notifications (
  notification_id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('follow','request','accepted','like','comment')),
  post_id TEXT REFERENCES posts(post_id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES post_comments(comment_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX notifications_inbox ON social_notifications(recipient_id,created_at DESC,notification_id);
CREATE TRIGGER like_notification AFTER INSERT ON post_likes BEGIN
  INSERT OR IGNORE INTO social_notifications(notification_id,recipient_id,actor_id,kind,post_id,created_at)
    SELECT 'like:'||NEW.post_id||':'||NEW.user_id,author_id,NEW.user_id,'like',NEW.post_id,NEW.created_at FROM posts WHERE post_id=NEW.post_id AND author_id!=NEW.user_id;
END;
CREATE TRIGGER unlike_notification AFTER DELETE ON post_likes BEGIN
  DELETE FROM social_notifications WHERE notification_id='like:'||OLD.post_id||':'||OLD.user_id;
END;
CREATE TRIGGER comment_notification AFTER INSERT ON post_comments BEGIN
  INSERT INTO social_notifications(notification_id,recipient_id,actor_id,kind,post_id,comment_id,created_at)
    SELECT 'comment:'||NEW.comment_id,author_id,NEW.user_id,'comment',NEW.post_id,NEW.comment_id,NEW.created_at FROM posts WHERE post_id=NEW.post_id AND author_id!=NEW.user_id;
END;
CREATE TRIGGER follow_notification_insert AFTER INSERT ON followers WHEN NEW.state!='REMOVED' BEGIN
  INSERT OR IGNORE INTO social_notifications(notification_id,recipient_id,actor_id,kind,created_at)
    VALUES('follow:'||NEW.target_id||':'||NEW.follower_id,NEW.target_id,NEW.follower_id,CASE NEW.state WHEN 'PENDING' THEN 'request' ELSE 'follow' END,NEW.updated_at);
END;
CREATE TRIGGER follow_notification_update AFTER UPDATE OF state ON followers WHEN OLD.state!=NEW.state BEGIN
  DELETE FROM social_notifications WHERE notification_id IN ('follow:'||NEW.target_id||':'||NEW.follower_id,'accepted:'||NEW.target_id||':'||NEW.follower_id);
  INSERT OR IGNORE INTO social_notifications(notification_id,recipient_id,actor_id,kind,created_at)
    SELECT 'follow:'||NEW.target_id||':'||NEW.follower_id,NEW.target_id,NEW.follower_id,CASE NEW.state WHEN 'PENDING' THEN 'request' ELSE 'follow' END,NEW.updated_at WHERE NEW.state!='REMOVED';
  INSERT OR IGNORE INTO social_notifications(notification_id,recipient_id,actor_id,kind,created_at)
    SELECT 'accepted:'||NEW.target_id||':'||NEW.follower_id,NEW.follower_id,NEW.target_id,'accepted',NEW.updated_at WHERE OLD.state='PENDING' AND NEW.state='APPROVED';
END;
CREATE TRIGGER block_social_notifications AFTER INSERT ON blocks BEGIN
  DELETE FROM social_notifications WHERE (actor_id=NEW.blocker_id AND recipient_id=NEW.blocked_id) OR (actor_id=NEW.blocked_id AND recipient_id=NEW.blocker_id);
END;
CREATE TRIGGER delete_post_social AFTER UPDATE OF state ON posts WHEN NEW.state='DELETED' BEGIN
  DELETE FROM post_comments WHERE post_id=NEW.post_id;
  DELETE FROM post_likes WHERE post_id=NEW.post_id;
  DELETE FROM post_saves WHERE post_id=NEW.post_id;
  DELETE FROM social_notifications WHERE post_id=NEW.post_id;
END;
