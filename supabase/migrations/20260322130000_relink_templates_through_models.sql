-- 迁移：将请求模板关联从 check_configs 上移到 check_models
-- 目标链路：check_configs -> check_models -> check_request_templates

-- -----------------------------------------------------------------------------
-- public schema
-- -----------------------------------------------------------------------------

ALTER TABLE public.check_models
    ADD COLUMN IF NOT EXISTS template_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'check_models_template_id_fkey'
          AND conrelid = 'public.check_models'::regclass
    ) THEN
        ALTER TABLE public.check_models
            ADD CONSTRAINT check_models_template_id_fkey
            FOREIGN KEY (template_id)
            REFERENCES public.check_request_templates(id)
            ON DELETE SET NULL;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_check_models_template_id
    ON public.check_models (template_id);

COMMENT ON COLUMN public.check_models.template_id IS '请求模板 ID，关联 check_request_templates.id';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.check_configs
        WHERE request_header IS NOT NULL
           OR metadata IS NOT NULL
    ) THEN
        RAISE EXCEPTION '存在 check_configs.request_header 或 metadata 数据，无法自动迁移；请先人工清理实例级覆盖';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.check_configs
        WHERE template_id IS NOT NULL
        GROUP BY model_id
        HAVING COUNT(DISTINCT template_id) > 1
    ) THEN
        RAISE EXCEPTION '同一个模型被多个不同模板引用，无法自动迁移；请先拆分模型';
    END IF;
END
$$;

WITH model_template_source AS (
    SELECT
        m.id AS model_id,
        m.type,
        m.model,
        (ARRAY_AGG(DISTINCT c.template_id) FILTER (WHERE c.template_id IS NOT NULL))[1] AS inherited_template_id,
        COALESCE(m.request_header, '{}'::jsonb) AS model_request_header,
        COALESCE(m.metadata, '{}'::jsonb) AS model_metadata
    FROM public.check_models AS m
    LEFT JOIN public.check_configs AS c
        ON c.model_id = m.id
    GROUP BY m.id, m.type, m.model, m.request_header, m.metadata
),
templates_to_materialize AS (
    SELECT
        src.model_id,
        src.type,
        '__migrated_model_template__' || src.model_id::text AS name,
        NULLIF(
            COALESCE(base.request_header, '{}'::jsonb) || src.model_request_header,
            '{}'::jsonb
        ) AS request_header,
        NULLIF(
            COALESCE(base.metadata, '{}'::jsonb) || src.model_metadata,
            '{}'::jsonb
        ) AS metadata
    FROM model_template_source AS src
    LEFT JOIN public.check_request_templates AS base
        ON base.id = src.inherited_template_id
    WHERE src.model_request_header <> '{}'::jsonb
       OR src.model_metadata <> '{}'::jsonb
),
inserted_templates AS (
    INSERT INTO public.check_request_templates (name, type, request_header, metadata)
    SELECT name, type, request_header, metadata
    FROM templates_to_materialize
    ON CONFLICT (name) DO UPDATE
    SET request_header = EXCLUDED.request_header,
        metadata = EXCLUDED.metadata,
        type = EXCLUDED.type
    RETURNING id, name
)
UPDATE public.check_models AS m
SET template_id = resolved.template_id
FROM (
    SELECT
        src.model_id,
        COALESCE(created.id, src.inherited_template_id) AS template_id
    FROM model_template_source AS src
    LEFT JOIN inserted_templates AS created
        ON created.name = '__migrated_model_template__' || src.model_id::text
) AS resolved
WHERE m.id = resolved.model_id
  AND m.template_id IS NULL;

DROP TRIGGER IF EXISTS validate_check_configs_template_type ON public.check_configs;
DROP FUNCTION IF EXISTS public.validate_check_config_template_type();

ALTER TABLE public.check_models
    DROP COLUMN IF EXISTS request_header,
    DROP COLUMN IF EXISTS metadata;

DROP INDEX IF EXISTS public.idx_check_configs_template_id;

ALTER TABLE public.check_configs
    DROP CONSTRAINT IF EXISTS check_configs_template_id_fkey;

ALTER TABLE public.check_configs
    DROP COLUMN IF EXISTS template_id,
    DROP COLUMN IF EXISTS request_header,
    DROP COLUMN IF EXISTS metadata;

CREATE OR REPLACE FUNCTION public.validate_check_model_template_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    linked_template_type public.provider_type;
BEGIN
    IF NEW.template_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT type
    INTO linked_template_type
    FROM public.check_request_templates
    WHERE id = NEW.template_id;

    IF linked_template_type IS NULL THEN
        RETURN NEW;
    END IF;

    IF linked_template_type <> NEW.type THEN
        RAISE EXCEPTION '模板类型不匹配: model.type=%, template.type=%', NEW.type, linked_template_type;
    END IF;

    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'validate_check_models_template_type'
          AND tgrelid = 'public.check_models'::regclass
    ) THEN
        CREATE TRIGGER validate_check_models_template_type
            BEFORE INSERT OR UPDATE OF template_id, type ON public.check_models
            FOR EACH ROW
            EXECUTE FUNCTION public.validate_check_model_template_type();
    END IF;
END
$$;

COMMENT ON TABLE public.check_models IS '模型配置表，存储可复用的模型定义与模板绑定';

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
            ALTER TABLE dev.check_models
                ADD COLUMN IF NOT EXISTS template_id uuid
        $sql$;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'check_models_template_id_fkey'
              AND conrelid = 'dev.check_models'::regclass
        ) THEN
            EXECUTE $sql$
                ALTER TABLE dev.check_models
                    ADD CONSTRAINT check_models_template_id_fkey
                    FOREIGN KEY (template_id)
                    REFERENCES dev.check_request_templates(id)
                    ON DELETE SET NULL
            $sql$;
        END IF;

        EXECUTE $sql$
            CREATE INDEX IF NOT EXISTS idx_dev_check_models_template_id
                ON dev.check_models (template_id)
        $sql$;

        EXECUTE $sql$
            COMMENT ON COLUMN dev.check_models.template_id IS
            '请求模板 ID - 关联 check_request_templates.id'
        $sql$;

        IF EXISTS (
            SELECT 1
            FROM dev.check_configs
            WHERE request_header IS NOT NULL
               OR metadata IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'dev schema 中存在 check_configs.request_header 或 metadata 数据，无法自动迁移';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM dev.check_configs
            WHERE template_id IS NOT NULL
            GROUP BY model_id
            HAVING COUNT(DISTINCT template_id) > 1
        ) THEN
            RAISE EXCEPTION 'dev schema 中同一个模型被多个不同模板引用，无法自动迁移';
        END IF;

        EXECUTE $sql$
            WITH model_template_source AS (
                SELECT
                    m.id AS model_id,
                    m.type,
                    m.model,
                    (ARRAY_AGG(DISTINCT c.template_id) FILTER (WHERE c.template_id IS NOT NULL))[1] AS inherited_template_id,
                    COALESCE(m.request_header, '{}'::jsonb) AS model_request_header,
                    COALESCE(m.metadata, '{}'::jsonb) AS model_metadata
                FROM dev.check_models AS m
                LEFT JOIN dev.check_configs AS c
                    ON c.model_id = m.id
                GROUP BY m.id, m.type, m.model, m.request_header, m.metadata
            ),
            templates_to_materialize AS (
                SELECT
                    src.model_id,
                    src.type,
                    '__migrated_model_template__' || src.model_id::text AS name,
                    NULLIF(
                        COALESCE(base.request_header, '{}'::jsonb) || src.model_request_header,
                        '{}'::jsonb
                    ) AS request_header,
                    NULLIF(
                        COALESCE(base.metadata, '{}'::jsonb) || src.model_metadata,
                        '{}'::jsonb
                    ) AS metadata
                FROM model_template_source AS src
                LEFT JOIN dev.check_request_templates AS base
                    ON base.id = src.inherited_template_id
                WHERE src.model_request_header <> '{}'::jsonb
                   OR src.model_metadata <> '{}'::jsonb
            ),
            inserted_templates AS (
                INSERT INTO dev.check_request_templates (name, type, request_header, metadata)
                SELECT name, type, request_header, metadata
                FROM templates_to_materialize
                ON CONFLICT (name) DO UPDATE
                SET request_header = EXCLUDED.request_header,
                    metadata = EXCLUDED.metadata,
                    type = EXCLUDED.type
                RETURNING id, name
            )
            UPDATE dev.check_models AS m
            SET template_id = resolved.template_id
            FROM (
                SELECT
                    src.model_id,
                    COALESCE(created.id, src.inherited_template_id) AS template_id
                FROM model_template_source AS src
                LEFT JOIN inserted_templates AS created
                    ON created.name = '__migrated_model_template__' || src.model_id::text
            ) AS resolved
            WHERE m.id = resolved.model_id
              AND m.template_id IS NULL
        $sql$;

        EXECUTE $sql$
            DROP TRIGGER IF EXISTS validate_check_configs_template_type ON dev.check_configs
        $sql$;

        EXECUTE $sql$
            DROP FUNCTION IF EXISTS dev.validate_check_config_template_type()
        $sql$;

        EXECUTE $sql$
            ALTER TABLE dev.check_models
                DROP COLUMN IF EXISTS request_header,
                DROP COLUMN IF EXISTS metadata
        $sql$;

        EXECUTE $sql$
            DROP INDEX IF EXISTS dev.idx_dev_check_configs_template_id
        $sql$;

        EXECUTE $sql$
            ALTER TABLE dev.check_configs
                DROP CONSTRAINT IF EXISTS check_configs_template_id_fkey
        $sql$;

        EXECUTE $sql$
            ALTER TABLE dev.check_configs
                DROP COLUMN IF EXISTS template_id,
                DROP COLUMN IF EXISTS request_header,
                DROP COLUMN IF EXISTS metadata
        $sql$;

        EXECUTE $sql$
            CREATE OR REPLACE FUNCTION dev.validate_check_model_template_type()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $function$
            DECLARE
              linked_template_type dev.provider_type;
            BEGIN
              IF NEW.template_id IS NULL THEN
                RETURN NEW;
              END IF;

              SELECT type
              INTO linked_template_type
              FROM dev.check_request_templates
              WHERE id = NEW.template_id;

              IF linked_template_type IS NULL THEN
                RETURN NEW;
              END IF;

              IF linked_template_type <> NEW.type THEN
                RAISE EXCEPTION '模板类型不匹配: model.type=%, template.type=%', NEW.type, linked_template_type;
              END IF;

              RETURN NEW;
            END;
            $function$
        $sql$;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgname = 'validate_check_models_template_type'
              AND tgrelid = 'dev.check_models'::regclass
        ) THEN
            EXECUTE $sql$
                CREATE TRIGGER validate_check_models_template_type
                BEFORE INSERT OR UPDATE OF template_id, type ON dev.check_models
                FOR EACH ROW
                EXECUTE FUNCTION dev.validate_check_model_template_type()
            $sql$;
        END IF;

        EXECUTE $sql$
            COMMENT ON TABLE dev.check_models IS
            '模型配置表 - 存储可复用模型定义与模板绑定'
        $sql$;
    END IF;
END
$dev$;
