-- 迁移：拆分模型配置表 check_models，并让 check_configs 通过 model_id 关联模型

-- -----------------------------------------------------------------------------
-- public schema
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.check_models (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type public.provider_type NOT NULL,
    model text NOT NULL,
    request_header jsonb,
    metadata jsonb,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'check_models_type_model_key'
          AND conrelid = 'public.check_models'::regclass
    ) THEN
        ALTER TABLE public.check_models
            ADD CONSTRAINT check_models_type_model_key UNIQUE (type, model);
    END IF;
END
$$;

COMMENT ON TABLE public.check_models IS '模型配置表，存储可复用的模型定义与模型级默认参数';
COMMENT ON COLUMN public.check_models.id IS '模型 UUID';
COMMENT ON COLUMN public.check_models.type IS '模型提供商类型: openai, gemini, anthropic';
COMMENT ON COLUMN public.check_models.model IS '模型名称，如 gpt-4o-mini';
COMMENT ON COLUMN public.check_models.request_header IS '模型默认请求头 (JSONB)';
COMMENT ON COLUMN public.check_models.metadata IS '模型默认 metadata，请求体参数 (JSONB)';
COMMENT ON COLUMN public.check_models.created_at IS '创建时间';
COMMENT ON COLUMN public.check_models.updated_at IS '更新时间';

ALTER TABLE public.check_models ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.check_configs
    ADD COLUMN IF NOT EXISTS model_id uuid;

INSERT INTO public.check_models (type, model)
SELECT DISTINCT c.type, c.model
FROM public.check_configs AS c
WHERE c.model IS NOT NULL
ON CONFLICT (type, model) DO NOTHING;

UPDATE public.check_configs AS c
SET model_id = m.id
FROM public.check_models AS m
WHERE c.model_id IS NULL
  AND m.type = c.type
  AND m.model = c.model;

ALTER TABLE public.check_configs
    ALTER COLUMN model_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'check_configs_model_id_fkey'
          AND conrelid = 'public.check_configs'::regclass
    ) THEN
        ALTER TABLE public.check_configs
            ADD CONSTRAINT check_configs_model_id_fkey
            FOREIGN KEY (model_id)
            REFERENCES public.check_models(id)
            ON DELETE RESTRICT;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_check_configs_model_id
    ON public.check_configs (model_id);

COMMENT ON COLUMN public.check_configs.model_id IS '模型 ID，关联 check_models.id';

ALTER TABLE public.check_configs
    DROP COLUMN IF EXISTS model;

CREATE OR REPLACE FUNCTION public.validate_check_config_model_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    linked_model_type public.provider_type;
BEGIN
    SELECT type
    INTO linked_model_type
    FROM public.check_models
    WHERE id = NEW.model_id;

    IF linked_model_type IS NULL THEN
        RETURN NEW;
    END IF;

    IF linked_model_type <> NEW.type THEN
        RAISE EXCEPTION '模型类型不匹配: config.type=%, model.type=%', NEW.type, linked_model_type;
    END IF;

    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'validate_check_configs_model_type'
          AND tgrelid = 'public.check_configs'::regclass
    ) THEN
        CREATE TRIGGER validate_check_configs_model_type
            BEFORE INSERT OR UPDATE OF model_id, type ON public.check_configs
            FOR EACH ROW
            EXECUTE FUNCTION public.validate_check_config_model_type();
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'update_check_models_updated_at'
          AND tgrelid = 'public.check_models'::regclass
    ) THEN
        CREATE TRIGGER update_check_models_updated_at
            BEFORE UPDATE ON public.check_models
            FOR EACH ROW
            EXECUTE FUNCTION public.update_updated_at_column();
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.get_recent_check_history(
    limit_per_config integer DEFAULT 60,
    target_config_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
    config_id       uuid,
    status          text,
    latency_ms      integer,
    ping_latency_ms integer,
    checked_at      timestamptz,
    message         text,
    name            text,
    type            text,
    model           text,
    endpoint        text,
    group_name      text
)
LANGUAGE sql
STABLE
AS $$
    WITH ranked AS (
        SELECT
            h.id AS history_id,
            h.config_id,
            h.status,
            h.latency_ms,
            h.ping_latency_ms,
            h.checked_at,
            h.message,
            row_number() OVER (PARTITION BY h.config_id ORDER BY h.checked_at DESC) AS rn
        FROM check_history h
        WHERE target_config_ids IS NULL OR h.config_id = ANY(target_config_ids)
    )
    SELECT
        r.config_id,
        r.status,
        r.latency_ms,
        r.ping_latency_ms::integer,
        r.checked_at,
        r.message,
        c.name,
        c.type::text,
        m.model,
        c.endpoint,
        c.group_name
    FROM ranked r
    JOIN check_configs c ON c.id = r.config_id
    JOIN check_models m ON m.id = c.model_id
    WHERE r.rn <= limit_per_config
    ORDER BY c.name ASC, r.checked_at DESC;
$$;

-- -----------------------------------------------------------------------------
-- optional dev schema
-- -----------------------------------------------------------------------------

DO $dev$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_namespace
        WHERE nspname = 'dev'
    ) THEN
        EXECUTE $sql$
            CREATE TABLE IF NOT EXISTS dev.check_models (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                type dev.provider_type NOT NULL,
                model text NOT NULL,
                request_header jsonb,
                metadata jsonb,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            )
        $sql$;

        EXECUTE $sql$
            ALTER TABLE dev.check_configs
                ADD COLUMN IF NOT EXISTS model_id uuid
        $sql$;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'check_models_type_model_key'
              AND conrelid = 'dev.check_models'::regclass
        ) THEN
            EXECUTE $sql$
                ALTER TABLE dev.check_models
                    ADD CONSTRAINT check_models_type_model_key UNIQUE (type, model)
            $sql$;
        END IF;

        EXECUTE $sql$
            INSERT INTO dev.check_models (type, model)
            SELECT DISTINCT c.type, c.model
            FROM dev.check_configs AS c
            WHERE c.model IS NOT NULL
            ON CONFLICT (type, model) DO NOTHING
        $sql$;

        EXECUTE $sql$
            UPDATE dev.check_configs AS c
            SET model_id = m.id
            FROM dev.check_models AS m
            WHERE c.model_id IS NULL
              AND m.type = c.type
              AND m.model = c.model
        $sql$;

        EXECUTE $sql$
            ALTER TABLE dev.check_configs
                ALTER COLUMN model_id SET NOT NULL
        $sql$;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'check_configs_model_id_fkey'
              AND conrelid = 'dev.check_configs'::regclass
        ) THEN
            EXECUTE $sql$
                ALTER TABLE dev.check_configs
                    ADD CONSTRAINT check_configs_model_id_fkey
                    FOREIGN KEY (model_id)
                    REFERENCES dev.check_models(id)
                    ON DELETE RESTRICT
            $sql$;
        END IF;

        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_dev_check_configs_model_id ON dev.check_configs (model_id)';
        EXECUTE 'ALTER TABLE dev.check_models ENABLE ROW LEVEL SECURITY';
        EXECUTE 'ALTER TABLE dev.check_configs DROP COLUMN IF EXISTS model';
        EXECUTE 'COMMENT ON TABLE dev.check_models IS ''模型配置表 - 存储可复用模型定义与模型级默认参数''';
        EXECUTE 'COMMENT ON COLUMN dev.check_configs.model_id IS ''模型 ID - 关联 check_models.id''';

        EXECUTE $sql$
            CREATE OR REPLACE FUNCTION dev.validate_check_config_model_type()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $fn$
            DECLARE
              linked_model_type dev.provider_type;
            BEGIN
              SELECT type
              INTO linked_model_type
              FROM dev.check_models
              WHERE id = NEW.model_id;

              IF linked_model_type IS NULL THEN
                RETURN NEW;
              END IF;

              IF linked_model_type <> NEW.type THEN
                RAISE EXCEPTION '模型类型不匹配: config.type=%, model.type=%', NEW.type, linked_model_type;
              END IF;

              RETURN NEW;
            END;
            $fn$
        $sql$;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgname = 'validate_check_configs_model_type'
              AND tgrelid = 'dev.check_configs'::regclass
        ) THEN
            EXECUTE $sql$
                CREATE TRIGGER validate_check_configs_model_type
                BEFORE INSERT OR UPDATE OF model_id, type ON dev.check_configs
                FOR EACH ROW
                EXECUTE FUNCTION dev.validate_check_config_model_type()
            $sql$;
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgname = 'update_check_models_updated_at'
              AND tgrelid = 'dev.check_models'::regclass
        ) THEN
            EXECUTE $sql$
                CREATE TRIGGER update_check_models_updated_at
                BEFORE UPDATE ON dev.check_models
                FOR EACH ROW
                EXECUTE FUNCTION dev.update_updated_at_column()
            $sql$;
        END IF;

        EXECUTE $sql$
            CREATE OR REPLACE FUNCTION dev.get_recent_check_history(
              limit_per_config integer DEFAULT 60,
              target_config_ids uuid[] DEFAULT NULL
            )
            RETURNS TABLE (
              config_id uuid,
              status text,
              latency_ms integer,
              ping_latency_ms double precision,
              checked_at timestamptz,
              message text,
              name text,
              type text,
              model text,
              endpoint text,
              group_name text
            )
            LANGUAGE sql
            STABLE
            AS $fn$
              WITH ranked AS (
                SELECT
                  h.id,
                  h.config_id,
                  h.status,
                  h.latency_ms,
                  h.ping_latency_ms,
                  h.checked_at,
                  h.message,
                  ROW_NUMBER() OVER (PARTITION BY h.config_id ORDER BY h.checked_at DESC) AS rn
                FROM dev.check_history h
                WHERE target_config_ids IS NULL OR h.config_id = ANY(target_config_ids)
              )
              SELECT
                r.config_id,
                r.status,
                r.latency_ms,
                r.ping_latency_ms,
                r.checked_at,
                r.message,
                c.name,
                c.type,
                m.model,
                c.endpoint,
                c.group_name
              FROM ranked r
              JOIN dev.check_configs c ON c.id = r.config_id
              JOIN dev.check_models m ON m.id = c.model_id
              WHERE r.rn <= limit_per_config
              ORDER BY c.name ASC, r.checked_at DESC;
            $fn$
        $sql$;
    END IF;
END
$dev$;
