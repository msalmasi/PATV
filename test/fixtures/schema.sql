-- The site database's schema (staging, 2026-10-08, '.schema' - tables and indexes only, no data).
-- Used by test/merge-coverage.test.js and test/account-merge.test.js. Refresh: sqlite3 -readonly myapp.db .schema
CREATE TABLE users (
        userId TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        avatar TEXT NOT NULL DEFAULT "avatar.png",
        class TEXT NOT NULL DEFAULT "pleb",
        displayname TEXT,
        email TEXT UNIQUE,
        password TEXT NOT NULL,
        discordId TEXT,
        discordUsername TEXT,
        twitchId TEXT,
        twitchDisplayname TEXT,
        streamId TEXT,
        streamKey TEXT,
        points_balance INTEGER DEFAULT 0,
        xp INTEGER DEFAULT 0,
        level INTEGER DEFAULT 0,
        liked INTEGER DEFAULT 0,
        discordBonus INTEGER DEFAULT 0,
        discordBonus_at TIMESTAMP,
        twitchBonus INTEGER DEFAULT 0,
        twitchBonus_at TIMESTAMP,
        emailVerificationToken VARCHAR(255),
        tokenExpires DATETIME,
        isEmailVerified INTEGER DEFAULT 0,
        resetPasswordToken TEXT,
        resetPasswordExpires DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    , camfrogUsername TEXT, extra_daily_spins INTEGER DEFAULT 0, casino_banned INTEGER DEFAULT 0, displayname_auto INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, twitchLogin TEXT, terms_accepted_version TEXT, terms_accepted_at INTEGER);
CREATE TABLE blackjack (
        blackjackId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        wager INTEGER NOT NULL,
        payout INTEGER DEFAULT 0,
        result TEXT, -- Win, Lose, Draw, Blackjack, etc.
        wagerTransactionId TEXT NOT NULL,
        payoutTransactionId TEXT,
        pvalue INTEGER, -- Player's final value
        spvalue INTEGER, -- Player's split final value (if applicable)
        dvalue INTEGER, -- Dealer's final value
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId),
        FOREIGN KEY (wagerTransactionId) REFERENCES transactions(transactionId),
        FOREIGN KEY (payoutTransactionId) REFERENCES transactions(transactionId)
        );
CREATE TABLE user_redemptions (
        redemption_id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        code TEXT NOT NULL,
        redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId),
        FOREIGN KEY (code) REFERENCES redemption_codes(code)
    );
CREATE TABLE redemption_codes (
        code TEXT PRIMARY KEY,
        points INTEGER NOT NULL,
        uses_allowed INTEGER DEFAULT 1,
        uses_remaining INTEGER DEFAULT 1,
        expiration_date DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE wheel_spins (
        spinId TEXT PRIMARY KEY,
        type TEXT,
        userId TEXT,
        result TEXT NOT NULL,
        transactionId TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, segment_index INTEGER, payout INTEGER, jackpot_pct INTEGER,
        FOREIGN KEY (userId) REFERENCES users(userId),
        FOREIGN KEY (transactionId) REFERENCES transactions(transactionId)
    );
CREATE TABLE jackpot_rakes (
        jackpotId TEXT PRIMARY KEY,
        spinId TEXT,
        userId TEXT,
        amount INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId),
        FOREIGN KEY (spinId) REFERENCES wheel_spins(spinId)
    );
CREATE TABLE levels (
        level INTEGER PRIMARY KEY,
        xp_required INTEGER NOT NULL,
        points_reward INTEGER NOT NULL
    );
CREATE TABLE classes (
        classId TEXT PRIMARY KEY,
        class TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE badges (
          badgeId TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          icon TEXT,
          points INTEGER DEFAULT 0,
          requirement TEXT NOT NULL,
          createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        , pat INTEGER DEFAULT 0);
CREATE TABLE user_badges (
          userId TEXT NOT NULL,
          badgeId TEXT NOT NULL,
          awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (userId, badgeId),
          FOREIGN KEY (userId) REFERENCES users(userId),
          FOREIGN KEY (badgeId) REFERENCES badges(badgeId)
               );
CREATE TABLE prizes (
        prizeId TEXT PRIMARY KEY,
        prize TEXT NOT NULL,
        cost INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    , quantity INTEGER NOT NULL DEFAULT 0, seller_id TEXT, description TEXT, category TEXT, delivery TEXT DEFAULT 'instant', image_url TEXT, buyer_prompt TEXT, status TEXT DEFAULT 'active', sold INTEGER DEFAULT 0, review_note TEXT, created INTEGER, updated INTEGER);
CREATE TABLE poker_cashier (
        cashierId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        transactionId TEXT NOT NULL,
        amount INTEGER NOT NULL,
        action TEXT NOT NULL, -- 'buyin' or 'cashout'
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId),
        FOREIGN KEY (transactionId) REFERENCES transactions(transactionId)
        );
CREATE TABLE bonus_winners (
        bonusId TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        userId TEXT NOT NULL,
        transactionId TEXT NOT NULL,
        amount INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId),
        FOREIGN KEY (transactionId) REFERENCES transactions(transactionId)
        );
CREATE TABLE transactions (
        transactionId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        type TEXT NOT NULL,
        points INTEGER NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT,
        FOREIGN KEY (userId) REFERENCES users(userId)
    );
CREATE UNIQUE INDEX idx_user_code ON user_redemptions (userId, code);
CREATE TABLE poker_now_games (
        pokerNowId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        url TEXT NOT NULL,
        blinds TEXT NOT NULL,
        date_created DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(userId)
    );
CREATE TABLE pending_camfrog_links (
  code TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  camfrogUsername TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);
CREATE TABLE user_roles (
        userId TEXT NOT NULL,
        role TEXT NOT NULL,
        source TEXT,
        granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (userId, role)
    );
CREATE TABLE reserve_claims (
    claimId TEXT PRIMARY KEY,
    flow TEXT NOT NULL,
    userId TEXT,
    type TEXT,
    amount INTEGER NOT NULL,
    created DATETIME DEFAULT CURRENT_TIMESTAMP,
    settled INTEGER DEFAULT 0
  );
CREATE TABLE achievement_feed (
    id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT, badgeId TEXT, patPaid INTEGER DEFAULT 0,
    created DATETIME DEFAULT CURRENT_TIMESTAMP, announced INTEGER DEFAULT 0);
CREATE TABLE achievement_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE supply_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY, endpoint TEXT NOT NULL, status INTEGER, body TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE markets (
  id INTEGER PRIMARY KEY, data TEXT NOT NULL, status TEXT, closes INTEGER, updated INTEGER);
CREATE TABLE media (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER,
  secs REAL, subject TEXT, by_user TEXT, room TEXT, created INTEGER, expires INTEGER,
  deleted INTEGER DEFAULT 0, anon INTEGER DEFAULT 0, source TEXT, stream TEXT, nsfw INTEGER DEFAULT 0, by_user_id TEXT, slot_id TEXT, subject_login TEXT);
CREATE TABLE heist_sheets (
  camfrog TEXT PRIMARY KEY, display TEXT, url TEXT NOT NULL, cls TEXT, updated INTEGER);
CREATE TABLE market_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, market_id INTEGER NOT NULL, user_id TEXT NOT NULL,
  username TEXT NOT NULL, camfrog TEXT, option TEXT NOT NULL, amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', message TEXT, created INTEGER, claimed INTEGER, updated INTEGER, kind TEXT DEFAULT 'buy', outcome TEXT, site_admin INTEGER DEFAULT 0, shares TEXT);
CREATE TABLE bounty_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bounty_id INTEGER NOT NULL, user_id TEXT NOT NULL,
  username TEXT NOT NULL, camfrog TEXT, kind TEXT NOT NULL, amount INTEGER, note TEXT, hunters TEXT,
  site_admin INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', message TEXT,
  created INTEGER, claimed INTEGER, updated INTEGER, evidence TEXT);
CREATE TABLE bounties (
  id INTEGER PRIMARY KEY, data TEXT NOT NULL, status TEXT, deadline INTEGER, updated INTEGER);
CREATE TABLE polls (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT, created TEXT, updated INTEGER);
CREATE TABLE wagers (
  id INTEGER PRIMARY KEY, data TEXT NOT NULL, status TEXT, updated INTEGER);
CREATE TABLE wallet_snapshots (
  key TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER);
CREATE TABLE pepe_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT NOT NULL, camfrog TEXT,
  site_admin INTEGER DEFAULT 0, kind TEXT NOT NULL, args TEXT NOT NULL, tag TEXT, label TEXT,
  status TEXT NOT NULL DEFAULT 'pending', message TEXT, created INTEGER, claimed INTEGER, updated INTEGER, idem TEXT, code TEXT, hint TEXT, incident TEXT);
CREATE TABLE lotto_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated INTEGER);
CREATE TABLE staking_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated INTEGER);
CREATE TABLE staking_daily (
    day TEXT PRIMARY KEY, ts INTEGER, prices TEXT, nav TEXT, staked TEXT, updated INTEGER);
CREATE TABLE user_cosmetics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item_id TEXT NOT NULL, source TEXT,
    acquired INTEGER, idem TEXT UNIQUE, locked INTEGER DEFAULT 0);
CREATE INDEX idx_user_cosmetics_user ON user_cosmetics (user_id);
CREATE TABLE user_cosmetic_equips (
    user_id TEXT NOT NULL, kind TEXT NOT NULL, inv_id INTEGER NOT NULL, PRIMARY KEY (user_id, kind));
CREATE TABLE cosmetic_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, inv_id INTEGER NOT NULL, seller_id TEXT NOT NULL, price INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', created INTEGER, updated INTEGER, buyer_id TEXT);
CREATE INDEX idx_cosmetic_listings_status ON cosmetic_listings (status);
CREATE TABLE user_badge_showcase (user_id TEXT PRIMARY KEY, badges TEXT);
CREATE TABLE cosmetic_transfers (
    idem TEXT PRIMARY KEY, inv_id INTEGER, from_id TEXT, to_id TEXT, listing_id INTEGER, created INTEGER);
CREATE TABLE cosmetic_avatar_seeds (camfrog TEXT PRIMARY KEY, seed INTEGER, updated INTEGER);
CREATE TABLE shop_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prize_id TEXT, buyer_id TEXT NOT NULL, seller_id TEXT, official INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL, price INTEGER NOT NULL, fee_pct REAL NOT NULL DEFAULT 0, fee INTEGER, net INTEGER,
    seller_paid INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, buyer_input TEXT, seller_note TEXT, dispute_reason TEXT, dispute_from TEXT, resolution TEXT,
    source TEXT, created INTEGER, fulfilled_at INTEGER, completed_at INTEGER, closed_at INTEGER, updated INTEGER);
CREATE TABLE shop_order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, ts INTEGER NOT NULL,
    status TEXT NOT NULL, actor TEXT, note TEXT);
CREATE TABLE shop_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE shop_prefs (
    user_id TEXT PRIMARY KEY, email_off INTEGER NOT NULL DEFAULT 0, pm_off INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_prizes_status ON prizes (status, seller_id);
CREATE INDEX idx_shop_orders_buyer ON shop_orders (buyer_id, id);
CREATE INDEX idx_shop_orders_seller ON shop_orders (seller_id, status);
CREATE INDEX idx_shop_orders_status ON shop_orders (status, updated);
CREATE INDEX idx_shop_events_order ON shop_order_events (order_id, id);
CREATE TABLE camfrog_userstats (
    login TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER);
CREATE TABLE camfrog_userstats_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1), tz TEXT, days INTEGER, updated INTEGER);
CREATE TABLE profile_layout (
  user_id TEXT PRIMARY KEY, layout TEXT NOT NULL, updated INTEGER);
CREATE TABLE bridge_rooms (
    id TEXT PRIMARY KEY, slug TEXT, name TEXT, snap TEXT, updated INTEGER);
CREATE TABLE bridge_feed (
    c INTEGER PRIMARY KEY, room_id TEXT NOT NULL, ts INTEGER, data TEXT NOT NULL);
CREATE INDEX bridge_feed_room ON bridge_feed (room_id, c);
CREATE TABLE tipjar_seen (
  userId TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
CREATE TABLE cosmetic_drop_config (key TEXT PRIMARY KEY, value REAL, updated INTEGER);
CREATE TABLE stage_slots (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        username TEXT,
        displayname TEXT,
        status TEXT NOT NULL,            -- waiting | active | ended
        created INTEGER NOT NULL,
        max_minutes INTEGER NOT NULL,
        price_per_min INTEGER NOT NULL,
        held INTEGER NOT NULL,
        live_ms INTEGER NOT NULL DEFAULT 0,
        charged INTEGER NOT NULL DEFAULT 0,
        refunded INTEGER,
        key_hash TEXT,
        stream TEXT NOT NULL,
        publishing INTEGER NOT NULL DEFAULT 0,
        beat INTEGER,
        went_live INTEGER,
        last_live INTEGER,
        ended INTEGER,
        end_reason TEXT,
        ended_by TEXT,
        revenue_vault TEXT,
        settled INTEGER NOT NULL DEFAULT 0
      , room_id TEXT, kind TEXT, featured INTEGER NOT NULL DEFAULT 0, feature_by TEXT, mode TEXT, embed TEXT, start_at INTEGER, bill_base_ms INTEGER NOT NULL DEFAULT 0, title TEXT, approved_by TEXT, notified INTEGER NOT NULL DEFAULT 0, capture_off INTEGER NOT NULL DEFAULT 0, nsfw INTEGER NOT NULL DEFAULT 0, via TEXT);
CREATE INDEX stage_slots_status ON stage_slots (status);
CREATE INDEX stage_slots_user ON stage_slots (userId, created);
CREATE TABLE stage_config (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE stage_bans (
        userId TEXT PRIMARY KEY, username TEXT, reason TEXT, by TEXT, at INTEGER);
CREATE TABLE stage_events (
        slot_id TEXT, ts INTEGER, what TEXT, actor TEXT, detail TEXT, room_id TEXT);
CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
    body TEXT, link TEXT, created INTEGER NOT NULL, read_at INTEGER, ref TEXT);
CREATE INDEX inbox_user ON inbox (user_id, id);
CREATE INDEX inbox_unread ON inbox (user_id, read_at);
CREATE UNIQUE INDEX inbox_ref ON inbox (user_id, ref);
CREATE TABLE inbox_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT, camfrog TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
    body TEXT, link TEXT, created INTEGER NOT NULL, ref TEXT);
CREATE UNIQUE INDEX inbox_pending_ref ON inbox_pending (camfrog, ref);
CREATE TABLE inbox_prefs (
    user_id TEXT NOT NULL, kind TEXT NOT NULL, pm_off INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, kind));
CREATE TABLE levelup_rewards (
  userId TEXT NOT NULL, level INTEGER NOT NULL, amount INTEGER NOT NULL, paid INTEGER NOT NULL DEFAULT 0,
  created DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (userId, level));
CREATE TABLE levelup_milestones (
    userId TEXT NOT NULL, level INTEGER NOT NULL, amount INTEGER NOT NULL, paid INTEGER NOT NULL DEFAULT 0,
    created DATETIME DEFAULT CURRENT_TIMESTAMP, paid_at DATETIME, PRIMARY KEY (userId, level));
CREATE TABLE cosmetic_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE displayname_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE displayname_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, old_name TEXT, new_name TEXT,
         auto INTEGER NOT NULL DEFAULT 0, via TEXT NOT NULL, actor TEXT, by_admin INTEGER NOT NULL DEFAULT 0,
         at INTEGER NOT NULL);
CREATE INDEX idx_displayname_log_user ON displayname_log (userId, at);
CREATE TABLE camfrog_roomstats (
    room_id TEXT PRIMARY KEY, name TEXT, data TEXT NOT NULL, updated INTEGER);
CREATE TABLE bridge_cmd_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT NOT NULL, username TEXT, camfrog TEXT,
  room TEXT, command TEXT, job TEXT, status TEXT, result TEXT, updated INTEGER);
CREATE TABLE camfrog_roomstats_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1), tz TEXT, days INTEGER, updated INTEGER);
CREATE TABLE welcome_bonus (
    userId TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL, decided INTEGER, amount INTEGER,
    reason TEXT, dup_of TEXT, connect_owed INTEGER DEFAULT 0, source TEXT);
CREATE TABLE pepe_control_cmds (
    id TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, mode TEXT NOT NULL,
    userId TEXT, username TEXT, ip_hash TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    claimed_at INTEGER, updated_at INTEGER, finished_at INTEGER, status TEXT NOT NULL, detail TEXT);
CREATE INDEX welcome_bonus_state ON welcome_bonus (state);
CREATE INDEX idx_pepe_control_cmds_status ON pepe_control_cmds (status, created_at);
CREATE TABLE welcome_keys (
    k TEXT NOT NULL, userId TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (k, userId));
CREATE TABLE pepe_control_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, userId TEXT, username TEXT, ip_hash TEXT,
    action TEXT NOT NULL, cmd_id TEXT, result TEXT);
CREATE INDEX welcome_keys_user ON welcome_keys (userId);
CREATE TABLE pepe_control_status (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL, data TEXT);
CREATE TABLE welcome_activity (userId TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (userId, day));
CREATE TABLE welcome_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX stage_slots_room ON stage_slots (room_id, status);
CREATE TABLE stage_room_bans (
        room_id TEXT NOT NULL, userId TEXT NOT NULL, username TEXT, reason TEXT, by TEXT, at INTEGER, PRIMARY KEY (room_id, userId));
CREATE TABLE stage_queue (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, userId TEXT NOT NULL, username TEXT, displayname TEXT,
        minutes INTEGER NOT NULL, feature INTEGER NOT NULL DEFAULT 0, mode TEXT, embed TEXT, title TEXT,
        created INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', slot_id TEXT, note TEXT, done INTEGER);
CREATE INDEX stage_queue_room ON stage_queue (room_id, status, created);
CREATE TABLE rooms_registry (
        room_id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT, description TEXT, banner TEXT,
        owner_kind TEXT NOT NULL DEFAULT 'none', owner_user_id TEXT,
        slot_count INTEGER NOT NULL DEFAULT 1, approval INTEGER NOT NULL DEFAULT 0, slot_price INTEGER NOT NULL DEFAULT 0,
        created INTEGER, updated INTEGER, platform TEXT);
CREATE UNIQUE INDEX rooms_registry_slug ON rooms_registry (slug);
CREATE INDEX rooms_registry_owner ON rooms_registry (owner_user_id);
CREATE TABLE rooms_kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE room_events (room_id TEXT, ts INTEGER, what TEXT, actor TEXT, detail TEXT);
CREATE INDEX room_events_room ON room_events (room_id, ts);
CREATE TABLE room_activity (
        room_id TEXT NOT NULL, day TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 0, peak INTEGER NOT NULL DEFAULT 0,
        lines INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (room_id, day));
CREATE TABLE royalty_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, kind TEXT NOT NULL,
        source TEXT, base INTEGER, amount INTEGER NOT NULL, period INTEGER NOT NULL, ref TEXT, created INTEGER NOT NULL, detail TEXT, category TEXT);
CREATE UNIQUE INDEX royalty_ledger_ref ON royalty_ledger (ref);
CREATE INDEX royalty_ledger_room ON royalty_ledger (room_id, owner_user_id, period);
CREATE TABLE royalty_runs (
        room_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, period INTEGER NOT NULL, outcome TEXT NOT NULL, amount INTEGER, at INTEGER,
        PRIMARY KEY (room_id, owner_user_id, period));
CREATE TABLE royalty_config (key TEXT PRIMARY KEY, value TEXT);
CREATE UNIQUE INDEX pepe_actions_idem ON pepe_actions (user_id, idem);
CREATE TABLE account_archive (
      userId TEXT PRIMARY KEY, run_id TEXT, tier TEXT, reason TEXT, archived_at INTEGER NOT NULL,
      balance REAL, reclaimed INTEGER NOT NULL DEFAULT 0, reclaim_tx TEXT, reclaim_claim TEXT,
      restored_at INTEGER, restored_via TEXT, restore_tx TEXT, restore_claim TEXT,
      purge_after INTEGER, purged_at INTEGER, snapshot TEXT);
CREATE INDEX account_archive_run ON account_archive (run_id);
CREATE INDEX royalty_ledger_created ON royalty_ledger (kind, created);
CREATE TABLE stale_notice (
      userId TEXT PRIMARY KEY, run_id TEXT NOT NULL, tier TEXT, balance REAL, login TEXT, username TEXT,
      noticed_at INTEGER NOT NULL, apply_on TEXT, state TEXT NOT NULL DEFAULT 'pending',
      cleared_at INTEGER, cleared_via TEXT, banner_at INTEGER);
CREATE INDEX stale_notice_state ON stale_notice (state);
CREATE TABLE stale_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE UNIQUE INDEX users_camfrog_login ON users (lower(trim(camfrogUsername)))
                    WHERE camfrogUsername IS NOT NULL AND trim(camfrogUsername) != '';
CREATE TABLE pepe_control_lastlook (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL, data TEXT);
CREATE TABLE feed_posts (
        id TEXT PRIMARY KEY, author_id TEXT NOT NULL, title TEXT, body TEXT, link_url TEXT, link_json TEXT,
        nsfw INTEGER NOT NULL DEFAULT 0, nsfw_admin INTEGER, global INTEGER NOT NULL DEFAULT 1,
        score INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, edited INTEGER, deleted_at INTEGER, deleted_by TEXT, delete_reason TEXT,
        hidden_at INTEGER, purged_at INTEGER, ups INTEGER NOT NULL DEFAULT 0, downs INTEGER NOT NULL DEFAULT 0, hot REAL NOT NULL DEFAULT 0, controversy REAL NOT NULL DEFAULT 0, locked_at INTEGER, locked_by TEXT, crosspost_of TEXT, in_all INTEGER NOT NULL DEFAULT 1, home_pad TEXT);
CREATE INDEX feed_posts_created ON feed_posts (created);
CREATE INDEX feed_posts_author ON feed_posts (author_id, created);
CREATE TABLE feed_post_rooms (
        post_id TEXT NOT NULL, room_id TEXT NOT NULL, created INTEGER, removed_at INTEGER, removed_by TEXT, pinned_at INTEGER, pinned_by TEXT, nsfw INTEGER, hidden_at INTEGER, hidden_by TEXT, pending INTEGER NOT NULL DEFAULT 0, approved_by TEXT,
        PRIMARY KEY (post_id, room_id));
CREATE INDEX feed_post_rooms_room ON feed_post_rooms (room_id, created);
CREATE TABLE feed_attachments (
        id TEXT PRIMARY KEY, post_id TEXT, owner_id TEXT NOT NULL, kind TEXT, ct TEXT, file TEXT, thumb TEXT, poster TEXT,
        w INTEGER, h INTEGER, secs REAL, bytes INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, error TEXT, created INTEGER NOT NULL, size_declared INTEGER, received INTEGER NOT NULL DEFAULT 0, sniff TEXT, ai_generated INTEGER NOT NULL DEFAULT 0, ai_prompt TEXT, ai_model TEXT, ai_nsfw INTEGER NOT NULL DEFAULT 0, ai_hide_prompt INTEGER NOT NULL DEFAULT 0, ai_job TEXT, purpose TEXT);
CREATE INDEX feed_att_post ON feed_attachments (post_id);
CREATE INDEX feed_att_owner ON feed_attachments (owner_id, created);
CREATE INDEX feed_att_file ON feed_attachments (file);
CREATE INDEX feed_att_thumb ON feed_attachments (thumb);
CREATE INDEX feed_att_poster ON feed_attachments (poster);
CREATE TABLE feed_votes (
        post_id TEXT NOT NULL, user_id TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 1, created INTEGER, w INTEGER NOT NULL DEFAULT 1, updated INTEGER, PRIMARY KEY (post_id, user_id));
CREATE TABLE feed_comments (
        id TEXT PRIMARY KEY, post_id TEXT NOT NULL, parent_id TEXT, author_id TEXT NOT NULL, body TEXT NOT NULL,
        created INTEGER NOT NULL, edited INTEGER, deleted_at INTEGER, deleted_by TEXT, ups INTEGER NOT NULL DEFAULT 0, downs INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0, hidden_at INTEGER);
CREATE INDEX feed_comments_post ON feed_comments (post_id, created);
CREATE INDEX feed_comments_author ON feed_comments (author_id, created);
CREATE TABLE feed_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, comment_id TEXT, reporter_id TEXT NOT NULL, reason TEXT,
        note TEXT, created INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT, action TEXT, notified_at INTEGER);
CREATE UNIQUE INDEX feed_reports_once ON feed_reports (post_id, COALESCE(comment_id, ''), reporter_id);
CREATE TABLE feed_bans (
        user_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', username TEXT, reason TEXT, by TEXT, at INTEGER, until INTEGER,
        PRIMARY KEY (user_id, room_id));
CREATE TABLE feed_restricted (
        login TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', reason TEXT, until INTEGER, PRIMARY KEY (login, room_id));
CREATE TABLE feed_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, post_id TEXT NOT NULL, created INTEGER NOT NULL, sent_at INTEGER);
CREATE UNIQUE INDEX feed_mentions_once ON feed_mentions (room_id, post_id);
CREATE TABLE feed_kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE story_seen (
        user_id TEXT NOT NULL, room_id TEXT NOT NULL, upto INTEGER NOT NULL, updated INTEGER, PRIMARY KEY (user_id, room_id));
CREATE TABLE follows (
        follower TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (follower, target_kind, target_id));
CREATE INDEX follows_target ON follows (target_kind, target_id);
CREATE TABLE follow_prefs (user_id TEXT PRIMARY KEY, notify_posts INTEGER NOT NULL DEFAULT 0, updated INTEGER);
CREATE TABLE feed_comment_votes (
    comment_id TEXT NOT NULL, post_id TEXT NOT NULL, user_id TEXT NOT NULL, value INTEGER NOT NULL, w INTEGER NOT NULL DEFAULT 1,
    created INTEGER, updated INTEGER, PRIMARY KEY (comment_id, user_id));
CREATE INDEX feed_cvotes_post ON feed_comment_votes (post_id, user_id);
CREATE INDEX feed_votes_user ON feed_votes (user_id, updated);
CREATE INDEX feed_votes_recent ON feed_votes (post_id, updated);
CREATE TABLE feed_room_members (room_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT, by TEXT, at INTEGER,
    PRIMARY KEY (room_id, user_id));
CREATE TABLE feed_room_report_done (room_id TEXT NOT NULL, post_id TEXT NOT NULL, comment_id TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL, by TEXT, action TEXT, PRIMARY KEY (room_id, post_id, comment_id));
CREATE INDEX feed_posts_hot ON feed_posts (hot);
CREATE INDEX feed_posts_score ON feed_posts (score, created);
CREATE INDEX feed_posts_contro ON feed_posts (controversy, created);
CREATE TABLE user_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL, reporter_id TEXT NOT NULL, reason TEXT, note TEXT, created INTEGER NOT NULL,
    resolved_at INTEGER, resolved_by TEXT, action TEXT, notified_at INTEGER);
CREATE INDEX user_reports_open ON user_reports (resolved_at, created);
CREATE INDEX user_reports_reporter ON user_reports (reporter_id, created);
CREATE INDEX feed_reports_reporter ON feed_reports (reporter_id, created);
CREATE TABLE content_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target_id TEXT NOT NULL, post_id TEXT, user_id TEXT NOT NULL,
        event TEXT NOT NULL, at INTEGER NOT NULL, ip TEXT, ua TEXT, ip_hash TEXT, via TEXT, lang TEXT, country TEXT,
        acct_age_s INTEGER, linked TEXT, session_hash TEXT, raw_purged_at INTEGER, bot INTEGER NOT NULL DEFAULT 0);
CREATE INDEX content_audit_target ON content_audit (kind, target_id);
CREATE INDEX content_audit_user ON content_audit (user_id, at);
CREATE INDEX content_audit_ip ON content_audit (ip_hash, at);
CREATE INDEX content_audit_sess ON content_audit (session_hash, at);
CREATE INDEX content_audit_at ON content_audit (at);
CREATE TABLE content_audit_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, admin_id TEXT NOT NULL, admin_name TEXT,
        target_kind TEXT NOT NULL, target_id TEXT NOT NULL, subject_id TEXT, reason TEXT);
CREATE INDEX content_audit_views_at ON content_audit_views (at);
CREATE TABLE content_audit_meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE pepe_feed_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, why TEXT,
        scope TEXT NOT NULL DEFAULT '', post_id TEXT, comment_id TEXT, target TEXT, kind TEXT, cost REAL NOT NULL DEFAULT 0, note TEXT, by TEXT);
CREATE INDEX pepe_feed_log_at ON pepe_feed_log (at);
CREATE INDEX pepe_feed_log_scope ON pepe_feed_log (scope, at);
CREATE TABLE pepe_feed_seen (target TEXT PRIMARY KEY, at INTEGER NOT NULL, outcome TEXT, offers INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pepe_feed_mutes (post_id TEXT PRIMARY KEY, by TEXT, at INTEGER);
CREATE INDEX feed_posts_xpost ON feed_posts (crosspost_of);
CREATE TABLE conversations (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'dm', dm_key TEXT, title TEXT, created_by TEXT, created_at INTEGER NOT NULL,
        last_msg_id INTEGER NOT NULL DEFAULT 0, last_msg_at INTEGER);
CREATE UNIQUE INDEX conversations_dm_key ON conversations (dm_key) WHERE dm_key IS NOT NULL;
CREATE INDEX conversations_creator ON conversations (created_by, created_at);
CREATE TABLE conversation_members (
        conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL,
        last_read_id INTEGER NOT NULL DEFAULT 0, cleared_id INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, left_at INTEGER, muted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (conversation_id, user_id));
CREATE INDEX conversation_members_user ON conversation_members (user_id);
CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, body TEXT, kind TEXT NOT NULL DEFAULT 'text',
        created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER, deleted_by TEXT);
CREATE INDEX messages_conv ON messages (conversation_id, id);
CREATE INDEX messages_sender ON messages (sender_id, created_at);
CREATE TABLE dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (blocker_id, blocked_id));
CREATE INDEX dm_blocks_blocked ON dm_blocks (blocked_id);
CREATE TABLE dm_prefs (user_id TEXT PRIMARY KEY, who TEXT NOT NULL DEFAULT 'everyone',
        alert_preview INTEGER NOT NULL DEFAULT 1, updated INTEGER);
CREATE TABLE dm_alerts (user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0,
        first_at INTEGER, last_msg_id INTEGER, last_alert_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, conversation_id));
CREATE INDEX dm_alerts_due ON dm_alerts (pending, first_at);
CREATE TABLE dm_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        reporter_id TEXT NOT NULL, reason TEXT, note TEXT, body TEXT, msg_at INTEGER, created INTEGER NOT NULL,
        resolved_at INTEGER, resolved_by TEXT, action TEXT, notified_at INTEGER);
CREATE UNIQUE INDEX dm_reports_once ON dm_reports (message_id, reporter_id);
CREATE INDEX dm_reports_open ON dm_reports (resolved_at, created);
CREATE INDEX dm_reports_reporter ON dm_reports (reporter_id, created);
CREATE TABLE stage_captures (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT, room_id TEXT NOT NULL, source TEXT NOT NULL, slot_id TEXT,
        stream_label TEXT, kind TEXT NOT NULL, ct TEXT NOT NULL, secs REAL, bytes INTEGER, nsfw INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, action_id INTEGER, media_id TEXT, message TEXT, created INTEGER NOT NULL, updated INTEGER);
CREATE INDEX stage_captures_user ON stage_captures (user_id, created);
CREATE TABLE admin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, admin_id TEXT NOT NULL, admin_name TEXT,
        action TEXT NOT NULL, target_id TEXT, target_name TEXT, detail TEXT, reason TEXT);
CREATE TABLE dm_media (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT, message_id INTEGER, state TEXT NOT NULL,
        file TEXT, thumb TEXT, w INTEGER, h INTEGER, bytes INTEGER NOT NULL DEFAULT 0, nsfw INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, size_declared INTEGER, received INTEGER NOT NULL DEFAULT 0, sniff TEXT, error TEXT, purged_at INTEGER);
CREATE INDEX admin_audit_action ON admin_audit (action, at);
CREATE INDEX dm_media_msg ON dm_media (message_id);
CREATE INDEX admin_audit_target ON admin_audit (target_id, at);
CREATE INDEX dm_media_owner ON dm_media (owner_id, created);
CREATE INDEX dm_media_file ON dm_media (file);
CREATE INDEX dm_media_thumb ON dm_media (thumb);
CREATE TABLE dm_member_adds (adder_id TEXT NOT NULL, conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX dm_member_adds_adder ON dm_member_adds (adder_id, at);
CREATE TABLE feed_automod (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        post_id TEXT, comment_id TEXT, room_id TEXT NOT NULL DEFAULT '', author_id TEXT, at INTEGER NOT NULL, action TEXT NOT NULL,
        severity TEXT, rule TEXT, rule_title TEXT, reason TEXT, model_action TEXT, model TEXT, cost REAL NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'done', reversed_at INTEGER, reversed_by TEXT, note TEXT, notified INTEGER NOT NULL DEFAULT 0);
CREATE INDEX feed_automod_room ON feed_automod (room_id, at);
CREATE INDEX feed_automod_at ON feed_automod (at);
CREATE TABLE feed_aigen_jobs (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT, camfrog TEXT, kind TEXT NOT NULL, prompt TEXT NOT NULL,
        pad TEXT, room TEXT, price INTEGER, cost INTEGER, status TEXT NOT NULL, message TEXT, refunded INTEGER NOT NULL DEFAULT 0,
        action_id INTEGER, attachment_id TEXT, nsfw INTEGER NOT NULL DEFAULT 0, model TEXT, back TEXT,
        created INTEGER NOT NULL, started INTEGER, progress_at INTEGER, secs INTEGER, finished INTEGER, polled INTEGER,
        notified INTEGER, received INTEGER NOT NULL DEFAULT 0, ref_att TEXT, origin TEXT, post_id TEXT, title TEXT, byline TEXT, ref_cam TEXT);
CREATE INDEX feed_aigen_user ON feed_aigen_jobs (user_id, created);
CREATE INDEX feed_aigen_status ON feed_aigen_jobs (status, created);
CREATE TABLE econ_config (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE econ_charges (ref TEXT PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL,
                  room_id TEXT NOT NULL DEFAULT '', flow TEXT NOT NULL, kind TEXT NOT NULL, payer TEXT, payer_kind TEXT,
                  amount INTEGER NOT NULL, via TEXT, received INTEGER);
CREATE INDEX econ_charges_day ON econ_charges (day, room_id);
CREATE TABLE econ_participation (room_id TEXT NOT NULL, day TEXT NOT NULL, login TEXT NOT NULL,
                  lines INTEGER DEFAULT 0, mic_min REAL DEFAULT 0, cmds INTEGER DEFAULT 0, active_min INTEGER DEFAULT 0,
                  updated INTEGER, PRIMARY KEY (room_id, day, login));
CREATE TABLE econ_watch (day TEXT NOT NULL, stream TEXT NOT NULL, room_id TEXT, streamer_id TEXT,
                  viewer_id TEXT NOT NULL, secs INTEGER DEFAULT 0, muted_secs INTEGER DEFAULT 0, beats INTEGER DEFAULT 0,
                  status TEXT DEFAULT 'ok', reason TEXT, updated INTEGER, PRIMARY KEY (day, stream, viewer_id));
CREATE INDEX econ_watch_room ON econ_watch (day, room_id);
CREATE TABLE econ_watch_keys (day TEXT NOT NULL, stream TEXT NOT NULL, k TEXT NOT NULL,
                  viewer_id TEXT NOT NULL, PRIMARY KEY (day, stream, k, viewer_id));
CREATE TABLE pat_burns (
      key TEXT PRIMARY KEY, id TEXT, at INTEGER NOT NULL, source TEXT NOT NULL, amount INTEGER NOT NULL,
      reason TEXT, actor_kind TEXT, actor TEXT, recorded_at INTEGER);
CREATE INDEX idx_pat_burns_at ON pat_burns (at);
CREATE TABLE room_flow_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, kind TEXT NOT NULL, room_id TEXT NOT NULL,
        payer_id TEXT, payer_name TEXT, amount INTEGER NOT NULL, fortknox INTEGER NOT NULL, room_vault INTEGER NOT NULL,
        owner_self INTEGER NOT NULL DEFAULT 0, via TEXT, created INTEGER NOT NULL, detail TEXT,
        migrated_fk INTEGER, migrated_rv INTEGER, fk_to TEXT);
CREATE UNIQUE INDEX room_flow_ref ON room_flow_ledger (ref);
CREATE INDEX room_flow_room ON room_flow_ledger (kind, room_id, created);
CREATE INDEX room_flow_payer ON room_flow_ledger (payer_id, created);
CREATE TABLE boost_config (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE fk_migrations (batch TEXT PRIMARY KEY, max_id INTEGER NOT NULL,
        amount INTEGER NOT NULL, rows INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE story_posts (
        capture_id TEXT PRIMARY KEY, post_id TEXT, room_id TEXT, author_id TEXT, posted_by TEXT, subject_user_id TEXT, subject_login TEXT,
        subject_name TEXT, room_title TEXT, kind TEXT, source TEXT, created INTEGER, removed_at INTEGER, removed_by TEXT, removed_reason TEXT);
CREATE INDEX story_posts_post ON story_posts (post_id);
CREATE TABLE story_keeps (
        capture_id TEXT PRIMARY KEY, kind TEXT, ct TEXT, file TEXT, thumb TEXT, poster TEXT, w INTEGER, h INTEGER, secs REAL, bytes INTEGER,
        created INTEGER, purged_at INTEGER, purge_reason TEXT);
CREATE INDEX story_keeps_file ON story_keeps (file);
CREATE TABLE story_saves (
        user_id TEXT NOT NULL, capture_id TEXT NOT NULL, created INTEGER, kind TEXT, room_id TEXT, room_title TEXT, subject TEXT, by_name TEXT,
        source TEXT, nsfw INTEGER NOT NULL DEFAULT 0, captured INTEGER, PRIMARY KEY (user_id, capture_id));
CREATE INDEX story_saves_capture ON story_saves (capture_id);
CREATE TABLE pad_looks (room_id TEXT PRIMARY KEY, avatar TEXT, banner TEXT, banner_y INTEGER NOT NULL DEFAULT 50,
        accent TEXT, cosmetics TEXT, updated INTEGER, updated_by TEXT, avatar_anim TEXT);
CREATE TABLE pad_cosmetic_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL, buyer_id TEXT, buyer_name TEXT, price INTEGER NOT NULL, owner_self INTEGER NOT NULL DEFAULT 0,
        ref TEXT NOT NULL, created INTEGER NOT NULL, decided INTEGER, decided_by TEXT);
CREATE UNIQUE INDEX pad_cos_ref ON pad_cosmetic_items (ref);
CREATE INDEX pad_cos_room ON pad_cosmetic_items (room_id, state);
CREATE TABLE pad_cosmetics_config (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE story_prefs (user_id TEXT PRIMARY KEY, captures_of_me INTEGER NOT NULL DEFAULT 1, updated INTEGER);
CREATE TABLE story_hides (user_id TEXT NOT NULL, capture_id TEXT NOT NULL, created INTEGER, PRIMARY KEY (user_id, capture_id));
CREATE INDEX media_subject_login ON media (subject_login);
CREATE TABLE image_safety_kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE image_safety_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        surface TEXT NOT NULL, kind TEXT, user_id TEXT, room_id TEXT, ref TEXT, hash TEXT, mode TEXT NOT NULL, action TEXT NOT NULL,
        flagged INTEGER NOT NULL DEFAULT 0, verdict TEXT, categories TEXT, scores TEXT, confidence REAL, reason TEXT, model TEXT,
        cost REAL NOT NULL DEFAULT 0, ms INTEGER, late INTEGER NOT NULL DEFAULT 0, would TEXT, thumb TEXT,
        review TEXT, reviewed_by TEXT, reviewed_at INTEGER, note TEXT);
CREATE INDEX image_safety_log_at ON image_safety_log (at);
CREATE INDEX image_safety_log_flag ON image_safety_log (flagged, at);
CREATE INDEX image_safety_log_hash ON image_safety_log (hash);
CREATE TABLE restream_dest (
        owner TEXT PRIMARY KEY,            -- userId, or "@main" (Pepe's main stream)
        service TEXT NOT NULL DEFAULT 'twitch',
        server TEXT NOT NULL,
        key_enc TEXT NOT NULL,             -- encrypt(key, owner): v1.<iv>.<tag>.<ct>
        last4 TEXT,
        auto INTEGER NOT NULL DEFAULT 0,   -- slots: on for my new slots
        updated INTEGER, by TEXT);
CREATE TABLE restream_toggles (
        target TEXT PRIMARY KEY,           -- "main" | "slot:<id>"
        enabled INTEGER NOT NULL, by TEXT, at INTEGER);
CREATE TABLE feed_quotes (post_id TEXT PRIMARY KEY, room_id TEXT, source TEXT, lines TEXT NOT NULL,
        logins TEXT, removed TEXT, created_by TEXT, created INTEGER);
CREATE INDEX feed_quotes_room ON feed_quotes (room_id, created);
CREATE TABLE feed_voices (post_id TEXT PRIMARY KEY, room_id TEXT, media_id TEXT, logins TEXT, by_login TEXT,
        created INTEGER, removed_at INTEGER, removed_by TEXT);
CREATE TABLE help_kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE help_misses (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, q TEXT NOT NULL,
        user_id TEXT, score REAL, why TEXT, top TEXT, resolved INTEGER NOT NULL DEFAULT 0);
CREATE INDEX help_misses_at ON help_misses (resolved, at);
CREATE TABLE pad_access (room_id TEXT PRIMARY KEY, level TEXT NOT NULL DEFAULT 'members',
                      updated INTEGER, updated_by TEXT);
CREATE TABLE pad_members (room_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
                      note TEXT, requested_at INTEGER, decided_at INTEGER, decided_by TEXT, PRIMARY KEY (room_id, user_id));
CREATE INDEX pad_members_user ON pad_members (user_id);
