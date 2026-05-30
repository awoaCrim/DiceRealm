import type { AppDatabase } from './connection.js';

export function migrate(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      world_info TEXT NOT NULL,
      current_turn INTEGER NOT NULL,
      status TEXT NOT NULL,
      ai_config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      is_connected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
      sheet_json TEXT NOT NULL,
      draft_source TEXT NOT NULL,
      confirmed INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rule_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_import_jobs (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_name TEXT NOT NULL DEFAULT '',
      source_file_name TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      source_version TEXT NOT NULL DEFAULT '',
      source_hash TEXT NOT NULL DEFAULT '',
      source_license TEXT NOT NULL DEFAULT '',
      ruleset TEXT NOT NULL DEFAULT 'unknown',
      language TEXT NOT NULL DEFAULT 'unknown',
      visibility TEXT NOT NULL DEFAULT 'private',
      is_private INTEGER NOT NULL DEFAULT 1,
      imported_by TEXT NOT NULL DEFAULT 'admin',
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (source_type IN ('local_json', 'phb_extraction', 'sillytavern_worldbook', 'sillytavern_preset', 'remote_url', 'manual')),
      CHECK (ruleset IN ('5e-2014', '5e-2024', 'homebrew', 'unknown')),
      CHECK (visibility IN ('private', 'campaign', 'workspace', 'public')),
      CHECK (is_private IN (0, 1)),
      CHECK (status IN ('imported', 'failed'))
    );

    CREATE TABLE IF NOT EXISTS resource_import_drafts (
      id TEXT NOT NULL PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES resource_import_jobs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_name TEXT NOT NULL DEFAULT '',
      source_file_name TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      source_version TEXT NOT NULL DEFAULT '',
      source_hash TEXT NOT NULL DEFAULT '',
      source_license TEXT NOT NULL DEFAULT '',
      ruleset TEXT NOT NULL DEFAULT 'unknown',
      language TEXT NOT NULL DEFAULT 'unknown',
      visibility TEXT NOT NULL DEFAULT 'private',
      is_private INTEGER NOT NULL DEFAULT 1,
      imported_by TEXT NOT NULL DEFAULT 'admin',
      content_hash TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      option_type TEXT,
      summary TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      keys_json TEXT NOT NULL DEFAULT '[]',
      source_ref TEXT NOT NULL DEFAULT '',
      rule_data_json TEXT NOT NULL DEFAULT '{}',
      prerequisites_json TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 100,
      raw_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      rejection_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (kind IN ('rule_entry', 'character_option', 'resource_rule', 'worldbook_entry', 'spell', 'monster', 'item', 'npc', 'campaign_entry', 'preset_module')),
      CHECK (source_type IN ('local_json', 'phb_extraction', 'sillytavern_worldbook', 'sillytavern_preset', 'remote_url', 'manual')),
      CHECK (ruleset IN ('5e-2014', '5e-2024', 'homebrew', 'unknown')),
      CHECK (visibility IN ('private', 'campaign', 'workspace', 'public')),
      CHECK (is_private IN (0, 1)),
      CHECK (status IN ('pending', 'approved', 'rejected')),
      CHECK (option_type IS NULL OR option_type IN ('species', 'class', 'background', 'skill', 'equipment', 'spell', 'language', 'proficiency')),
      CHECK ((kind = 'character_option' AND option_type IS NOT NULL) OR (kind != 'character_option' AND option_type IS NULL))
    );

    CREATE TABLE IF NOT EXISTS rule_world_book_entries (
      id TEXT NOT NULL PRIMARY KEY,
      draft_id TEXT NOT NULL UNIQUE REFERENCES resource_import_drafts(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      keys_json TEXT NOT NULL DEFAULT '[]',
      source_ref TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(category, title)
    );

    CREATE TABLE IF NOT EXISTS character_options (
      id TEXT NOT NULL PRIMARY KEY,
      draft_id TEXT NOT NULL UNIQUE REFERENCES resource_import_drafts(id) ON DELETE CASCADE,
      option_type TEXT NOT NULL,
      name TEXT NOT NULL,
      summary TEXT NOT NULL,
      rule_data_json TEXT NOT NULL DEFAULT '{}',
      prerequisites_json TEXT NOT NULL DEFAULT '{}',
      source_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (option_type IN ('species', 'class', 'background', 'skill', 'equipment', 'spell', 'language', 'proficiency')),
      UNIQUE(option_type, name)
    );

    CREATE TABLE IF NOT EXISTS resource_rules (
      id TEXT NOT NULL PRIMARY KEY,
      draft_id TEXT NOT NULL UNIQUE REFERENCES resource_import_drafts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      summary TEXT NOT NULL,
      rule_data_json TEXT NOT NULL DEFAULT '{}',
      source_ref TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(category, name)
    );

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      status TEXT NOT NULL,
      required_actor_ids_json TEXT NOT NULL DEFAULT '[]',
      submitted_actor_ids_json TEXT NOT NULL DEFAULT '[]',
      skipped_actor_ids_json TEXT NOT NULL DEFAULT '[]',
      excluded_actor_ids_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      UNIQUE(room_id, number)
    );

    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE(turn_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS interaction_requests (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      source_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      target_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      target_response TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS log_entries (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      visibility_scope TEXT NOT NULL,
      player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_generations (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      input_summary TEXT NOT NULL,
      output TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_turn_previews (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      original_prompt TEXT NOT NULL,
      edited_prompt TEXT,
      response_text TEXT,
      suggested_state_changes_json TEXT NOT NULL DEFAULT '[]',
      raw_json TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      CHECK (status IN ('previewed', 'sent', 'failed'))
    );

    CREATE TABLE IF NOT EXISTS prompt_presets (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_blocks (
      id TEXT PRIMARY KEY,
      preset_id TEXT NOT NULL REFERENCES prompt_presets(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      position TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      order_index INTEGER NOT NULL,
      content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS world_books (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS world_book_entries (
      id TEXT PRIMARY KEY,
      world_book_id TEXT NOT NULL REFERENCES world_books(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      keys_json TEXT NOT NULL,
      secondary_keys_json TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      constant INTEGER NOT NULL DEFAULT 0,
      selective INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 100,
      position TEXT NOT NULL DEFAULT 'after_world',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS script_cards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      personality TEXT NOT NULL DEFAULT '',
      scenario TEXT NOT NULL DEFAULT '',
      first_mes TEXT NOT NULL DEFAULT '',
      mes_example TEXT NOT NULL DEFAULT '',
      creator_notes TEXT NOT NULL DEFAULT '',
      visibility_notes TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_world_books (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_world_book_entries (
      id TEXT PRIMARY KEY,
      world_book_id TEXT NOT NULL REFERENCES resource_world_books(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      keys_json TEXT NOT NULL,
      secondary_keys_json TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      constant INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 100,
      order_index INTEGER NOT NULL DEFAULT 0,
      position TEXT NOT NULL DEFAULT 'after',
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_preset_packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      openai_settings_json TEXT NOT NULL,
      context_template_json TEXT,
      instruct_template_json TEXT,
      sysprompt_json TEXT,
      reasoning_template_json TEXT,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_config (
      id TEXT PRIMARY KEY,
      ai_config_json TEXT NOT NULL DEFAULT '{}',
      ai_provider_config_json TEXT NOT NULL DEFAULT '{"provider":"mock","baseUrl":"https://api.openai.com/v1","apiKey":"","model":"gpt-4o-mini"}',
      embedding_provider_config_json TEXT NOT NULL DEFAULT '{"provider":"mock","baseUrl":"https://api.openai.com/v1","apiKey":"","model":"text-embedding-3-small","dimensions":8}',
      active_script_card_id TEXT REFERENCES script_cards(id) ON DELETE SET NULL,
      active_preset_package_id TEXT REFERENCES prompt_preset_packages(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_world_book_bindings (
      world_book_id TEXT PRIMARY KEY REFERENCES resource_world_books(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_prompt_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_prompt_blocks (
      id TEXT PRIMARY KEY,
      preset_id TEXT NOT NULL REFERENCES global_prompt_presets(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      position TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      order_index INTEGER NOT NULL,
      content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_world_books (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS global_world_book_entries (
      id TEXT PRIMARY KEY,
      world_book_id TEXT NOT NULL REFERENCES global_world_books(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      keys_json TEXT NOT NULL,
      secondary_keys_json TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      constant INTEGER NOT NULL DEFAULT 0,
      selective INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 100,
      position TEXT NOT NULL DEFAULT 'after_world',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_script_bindings (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      script_card_id TEXT NOT NULL REFERENCES script_cards(id) ON DELETE CASCADE,
      binding_type TEXT NOT NULL DEFAULT 'main',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_world_book_bindings (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      world_book_id TEXT NOT NULL REFERENCES resource_world_books(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (room_id, world_book_id)
    );

    CREATE TABLE IF NOT EXISTS room_preset_bindings (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      preset_package_id TEXT NOT NULL REFERENCES prompt_preset_packages(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS character_resource_changes (
      id TEXT NOT NULL PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      path TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      rule_refs_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      reverted_at TEXT,
      reverted_by TEXT
    );

    CREATE TABLE IF NOT EXISTS npcs (
      id TEXT NOT NULL PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      hp_max INTEGER NOT NULL,
      hp_current INTEGER NOT NULL,
      ac INTEGER NOT NULL,
      str INTEGER NOT NULL DEFAULT 10,
      dex INTEGER NOT NULL DEFAULT 10,
      con INTEGER NOT NULL DEFAULT 10,
      int INTEGER NOT NULL DEFAULT 10,
      wis INTEGER NOT NULL DEFAULT 10,
      cha INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS combat_state (
      id TEXT NOT NULL PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dice_logs (
      id TEXT NOT NULL PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      combat_id TEXT REFERENCES combat_state(id) ON DELETE SET NULL,
      character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
      dice_type TEXT NOT NULL,
      values_json TEXT NOT NULL,
      modifier INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL,
      dc INTEGER,
      success INTEGER,
      is_public INTEGER NOT NULL DEFAULT 1,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_summaries (
      id TEXT NOT NULL PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_start INTEGER NOT NULL,
      turn_end INTEGER NOT NULL,
      summary TEXT NOT NULL,
      quest_updates_json TEXT NOT NULL DEFAULT '[]',
      npc_updates_json TEXT NOT NULL DEFAULT '[]',
      location_updates_json TEXT NOT NULL DEFAULT '[]',
      character_updates_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_quests (
      id TEXT NOT NULL PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      description TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_npcs (
      id TEXT NOT NULL PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      attitude TEXT NOT NULL DEFAULT 'neutral',
      notes TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_locations (
      id TEXT NOT NULL PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS remote_db_sources (
      id TEXT NOT NULL PRIMARY KEY,
      url TEXT NOT NULL,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '',
      file_hash TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      entry_count INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS remote_db_imports (
      source_id TEXT NOT NULL REFERENCES remote_db_sources(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      has_local_edits INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(source_id, resource_type, resource_id)
    );
  `);

  upgradeResourceImportSchema(db);
  createRuleEmbeddingTables(db);

  db.prepare('CREATE INDEX IF NOT EXISTS resource_import_drafts_job_id_idx ON resource_import_drafts(job_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS resource_import_drafts_status_idx ON resource_import_drafts(status)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS resource_import_drafts_kind_idx ON resource_import_drafts(kind)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS resource_import_drafts_source_type_idx ON resource_import_drafts(source_type)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS resource_import_drafts_ruleset_language_idx ON resource_import_drafts(ruleset, language)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS character_options_type_idx ON character_options(option_type)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS rule_world_book_entries_category_idx ON rule_world_book_entries(category)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS resource_rules_category_idx ON resource_rules(category)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS character_resource_changes_room_char_idx ON character_resource_changes(room_id, character_id, created_at)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS ai_turn_previews_room_idx ON ai_turn_previews(room_id, created_at)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS session_summaries_room_idx ON session_summaries(room_id, created_at)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS campaign_quests_room_idx ON campaign_quests(room_id, title)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS campaign_npcs_room_idx ON campaign_npcs(room_id, name)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS campaign_locations_room_idx ON campaign_locations(room_id, name)').run();
  createResourceCatalogTriggers(db);

  db.prepare(`
    UPDATE global_prompt_presets
    SET is_active = 0
    WHERE is_active = 1
      AND id NOT IN (
        SELECT id FROM global_prompt_presets
        WHERE is_active = 1
        ORDER BY updated_at DESC, created_at DESC, id ASC
        LIMIT 1
      )
  `).run();
  db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS global_prompt_presets_one_active_idx ON global_prompt_presets(is_active) WHERE is_active = 1').run();

  const roomColumns = db.prepare('PRAGMA table_info(rooms)').all() as Array<{ name: string }>;
  if (!roomColumns.some((column) => column.name === 'ai_config_json')) {
    db.prepare("ALTER TABLE rooms ADD COLUMN ai_config_json TEXT NOT NULL DEFAULT '{}'").run();
  }

  const globalConfigColumns = db.prepare('PRAGMA table_info(global_config)').all() as Array<{ name: string }>;
  if (!globalConfigColumns.some((column) => column.name === 'ai_provider_config_json')) {
    db.prepare('ALTER TABLE global_config ADD COLUMN ai_provider_config_json TEXT NOT NULL DEFAULT \'{"provider":"mock","baseUrl":"https://api.openai.com/v1","apiKey":"","model":"gpt-4o-mini"}\'').run();
  }
  if (!globalConfigColumns.some((column) => column.name === 'embedding_provider_config_json')) {
    db.prepare('ALTER TABLE global_config ADD COLUMN embedding_provider_config_json TEXT NOT NULL DEFAULT \'{"provider":"mock","baseUrl":"https://api.openai.com/v1","apiKey":"","model":"text-embedding-3-small","dimensions":8}\'').run();
  }

  // --- Structured Preset Engine columns ---
  addColumnIfMissing(db, 'prompt_blocks', 'category', 'TEXT');
  addColumnIfMissing(db, 'prompt_blocks', 'scene_type', "TEXT DEFAULT 'all'");
  addColumnIfMissing(db, 'prompt_presets', 'preset_type', 'TEXT');
  addColumnIfMissing(db, 'prompt_presets', 'is_template', 'INTEGER DEFAULT 0');

  addColumnIfMissing(db, 'global_prompt_blocks', 'category', 'TEXT');
  addColumnIfMissing(db, 'global_prompt_blocks', 'scene_type', "TEXT DEFAULT 'all'");
  addColumnIfMissing(db, 'global_prompt_presets', 'preset_type', 'TEXT');
  addColumnIfMissing(db, 'global_prompt_presets', 'is_template', 'INTEGER DEFAULT 0');

  // --- Exploration & Social ---
  addColumnIfMissing(db, 'actions', 'action_type', 'TEXT');
  addColumnIfMissing(db, 'actions', 'is_hidden_roll', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'turns', 'required_actor_ids_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'turns', 'submitted_actor_ids_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'turns', 'skipped_actor_ids_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'turns', 'excluded_actor_ids_json', "TEXT NOT NULL DEFAULT '[]'");
}

function addColumnIfMissing(db: AppDatabase, table: string, column: string, colDef: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${colDef}`).run();
  }
}

function tableSql(db: AppDatabase, name: string): string {
  return (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { sql?: string } | undefined
  )?.sql ?? '';
}

function tableExists(db: AppDatabase, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function upgradeResourceImportSchema(db: AppDatabase): void {
  if (tableExists(db, 'phb_extraction_jobs')) {
    db.prepare(`
      INSERT OR IGNORE INTO resource_import_jobs (
        id, name, source_type, source_name, source_file_name, source_url, source_version,
        source_hash, source_license, ruleset, language, visibility, is_private, imported_by,
        status, error_message, created_at, updated_at
      )
      SELECT id, name, 'phb_extraction', name, source_file_name, '', '', '', '', '5e-2014',
        'unknown', 'private', 1, 'legacy-migration', status, error_message, created_at, updated_at
      FROM phb_extraction_jobs
    `).run();
  }

  if (tableExists(db, 'phb_extraction_drafts')) {
    db.prepare(`
      INSERT OR IGNORE INTO resource_import_drafts (
        id, job_id, kind, source_type, source_name, source_file_name, source_url, source_version,
        source_hash, source_license, ruleset, language, visibility, is_private, imported_by,
        content_hash, title, category, option_type, summary, content, keys_json, source_ref,
        rule_data_json, prerequisites_json, priority, raw_json, status, rejection_reason,
        created_at, updated_at
      )
      SELECT d.id, d.job_id, d.kind, 'phb_extraction', j.name, j.source_file_name, '', '', '', '',
        '5e-2014', 'unknown', 'private', 1, 'legacy-migration', '', d.title, d.category,
        d.option_type, d.summary, d.content, d.keys_json, d.source_ref, d.rule_data_json,
        d.prerequisites_json, d.priority, d.raw_json, d.status, d.rejection_reason,
        d.created_at, d.updated_at
      FROM phb_extraction_drafts d
      JOIN phb_extraction_jobs j ON j.id = d.job_id
    `).run();
  }

  const needsCatalogRebuild = ['rule_world_book_entries', 'character_options', 'resource_rules']
    .some((name) => tableSql(db, name).includes('phb_extraction_drafts'));
  if (!needsCatalogRebuild) {
    return;
  }

  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE rule_world_book_entries_new (
        id TEXT NOT NULL PRIMARY KEY,
        draft_id TEXT NOT NULL UNIQUE REFERENCES resource_import_drafts(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        keys_json TEXT NOT NULL DEFAULT '[]',
        source_ref TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 100,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(category, title)
      );

      CREATE TABLE character_options_new (
        id TEXT NOT NULL PRIMARY KEY,
        draft_id TEXT NOT NULL UNIQUE REFERENCES resource_import_drafts(id) ON DELETE CASCADE,
        option_type TEXT NOT NULL,
        name TEXT NOT NULL,
        summary TEXT NOT NULL,
        rule_data_json TEXT NOT NULL DEFAULT '{}',
        prerequisites_json TEXT NOT NULL DEFAULT '{}',
        source_ref TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (option_type IN ('species', 'class', 'background', 'skill', 'equipment', 'spell', 'language', 'proficiency')),
        UNIQUE(option_type, name)
      );

      CREATE TABLE resource_rules_new (
        id TEXT NOT NULL PRIMARY KEY,
        draft_id TEXT NOT NULL UNIQUE REFERENCES resource_import_drafts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        summary TEXT NOT NULL,
        rule_data_json TEXT NOT NULL DEFAULT '{}',
        source_ref TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(category, name)
      );

      INSERT OR IGNORE INTO rule_world_book_entries_new (
        id, draft_id, title, category, summary, content, keys_json, source_ref, priority, enabled, created_at, updated_at
      )
      SELECT id, draft_id, title, category, summary, content, keys_json, source_ref, priority, enabled, created_at, updated_at
      FROM rule_world_book_entries;

      INSERT OR IGNORE INTO character_options_new (
        id, draft_id, option_type, name, summary, rule_data_json, prerequisites_json, source_ref, created_at, updated_at
      )
      SELECT id, draft_id, option_type, name, summary, rule_data_json, prerequisites_json, source_ref, created_at, updated_at
      FROM character_options;

      INSERT OR IGNORE INTO resource_rules_new (
        id, draft_id, name, category, summary, rule_data_json, source_ref, created_at, updated_at
      )
      SELECT id, draft_id, name, category, summary, rule_data_json, source_ref, created_at, updated_at
      FROM resource_rules;

      DROP TABLE rule_world_book_entries;
      DROP TABLE character_options;
      DROP TABLE resource_rules;

      ALTER TABLE rule_world_book_entries_new RENAME TO rule_world_book_entries;
      ALTER TABLE character_options_new RENAME TO character_options;
      ALTER TABLE resource_rules_new RENAME TO resource_rules;
    `);
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

function createRuleEmbeddingTables(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_entry_embeddings (
      entry_id TEXT NOT NULL PRIMARY KEY REFERENCES rule_world_book_entries(id) ON DELETE CASCADE,
      embedding_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rule_context_hits (
      id TEXT NOT NULL PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      entry_id TEXT NOT NULL REFERENCES rule_world_book_entries(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      reason TEXT NOT NULL,
      score REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare('CREATE INDEX IF NOT EXISTS rule_context_hits_room_turn_idx ON rule_context_hits(room_id, turn_id, created_at)').run();
}

function createResourceCatalogTriggers(db: AppDatabase): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS resource_import_drafts_catalog_guard_update
    BEFORE UPDATE OF kind, status ON resource_import_drafts
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'Approved resource catalog drafts cannot be downgraded or retagged')
      WHERE EXISTS (SELECT 1 FROM rule_world_book_entries WHERE draft_id = OLD.id)
        AND (NEW.kind != 'rule_entry' OR NEW.status != 'approved');

      SELECT RAISE(ABORT, 'Approved resource catalog drafts cannot be downgraded or retagged')
      WHERE EXISTS (SELECT 1 FROM character_options WHERE draft_id = OLD.id)
        AND (NEW.kind != 'character_option' OR NEW.status != 'approved');

      SELECT RAISE(ABORT, 'Approved resource catalog drafts cannot be downgraded or retagged')
      WHERE EXISTS (SELECT 1 FROM resource_rules WHERE draft_id = OLD.id)
        AND (NEW.kind != 'resource_rule' OR NEW.status != 'approved');
    END;

    CREATE TRIGGER IF NOT EXISTS rule_world_book_entries_resource_draft_guard_insert
    BEFORE INSERT ON rule_world_book_entries
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'rule_world_book_entries require an approved rule_entry draft')
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_import_drafts
        WHERE id = NEW.draft_id AND kind = 'rule_entry' AND status = 'approved'
      );
    END;

    CREATE TRIGGER IF NOT EXISTS rule_world_book_entries_resource_draft_guard_update
    BEFORE UPDATE ON rule_world_book_entries
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'rule_world_book_entries require an approved rule_entry draft')
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_import_drafts
        WHERE id = NEW.draft_id AND kind = 'rule_entry' AND status = 'approved'
      );
    END;

    CREATE TRIGGER IF NOT EXISTS character_options_resource_draft_guard_insert
    BEFORE INSERT ON character_options
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'character_options require an approved character_option draft')
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_import_drafts
        WHERE id = NEW.draft_id AND kind = 'character_option' AND status = 'approved'
      );
    END;

    CREATE TRIGGER IF NOT EXISTS character_options_resource_draft_guard_update
    BEFORE UPDATE ON character_options
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'character_options require an approved character_option draft')
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_import_drafts
        WHERE id = NEW.draft_id AND kind = 'character_option' AND status = 'approved'
      );
    END;

    CREATE TRIGGER IF NOT EXISTS resource_rules_resource_draft_guard_insert
    BEFORE INSERT ON resource_rules
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'resource_rules require an approved resource_rule draft')
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_import_drafts
        WHERE id = NEW.draft_id AND kind = 'resource_rule' AND status = 'approved'
      );
    END;

    CREATE TRIGGER IF NOT EXISTS resource_rules_resource_draft_guard_update
    BEFORE UPDATE ON resource_rules
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'resource_rules require an approved resource_rule draft')
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_import_drafts
        WHERE id = NEW.draft_id AND kind = 'resource_rule' AND status = 'approved'
      );
    END;
  `);
}
