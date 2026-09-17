-- Struttura del sito ComfortService nel database unico, per tests/site-copy.test.js: migrazioni 001-017 di
-- ComfortService (backend/migrations/site) applicate come cs_site su public dopo 0009, poi
-- `pg_dump --schema-only -n public --no-owner --no-acl --no-comments` (commenti del dump e CREATE SCHEMA tolti).
-- Il test la carica come cs_site in public (destinazione) e, con public. sostituito, nello schema della sorgente.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE public.contact_messages (
    id bigint NOT NULL,
    name text NOT NULL,
    reply_to_email text NOT NULL,
    subject text,
    body text NOT NULL,
    lang_code text,
    source_page text,
    ip_hash text,
    user_agent text,
    status text DEFAULT 'queued'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    provider_message_id text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT contact_messages_status_valid CHECK ((status = ANY (ARRAY['queued'::text, 'sent'::text, 'failed'::text])))
);

ALTER TABLE public.contact_messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.contact_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.faq_translations (
    id bigint NOT NULL,
    faq_id bigint NOT NULL,
    lang_code text NOT NULL,
    question text NOT NULL,
    answer text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.faq_translations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.faq_translations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.faqs (
    id bigint NOT NULL,
    faq_key text NOT NULL,
    page_key text,
    topic text DEFAULT 'generale'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.faqs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.faqs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.languages (
    code text NOT NULL,
    label text NOT NULL,
    label_short text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT languages_code_format CHECK ((code ~ '^[a-z]{2}(-[a-z]{2})?$'::text))
);

CREATE TABLE public.page_translations (
    id bigint NOT NULL,
    page_id bigint NOT NULL,
    lang_code text NOT NULL,
    slug text NOT NULL,
    meta_title text NOT NULL,
    meta_description text NOT NULL,
    og_title text,
    og_description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT page_translations_desc_len CHECK (((char_length(meta_description) >= 50) AND (char_length(meta_description) <= 165))),
    CONSTRAINT page_translations_slug_format CHECK ((slug ~ '^$|^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT page_translations_title_len CHECK (((char_length(meta_title) >= 10) AND (char_length(meta_title) <= 70)))
);

ALTER TABLE public.page_translations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.page_translations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.pages (
    id bigint NOT NULL,
    page_key text NOT NULL,
    kind text NOT NULL,
    service_slug text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pages_kind_valid CHECK ((kind = ANY (ARRAY['home'::text, 'product'::text, 'service'::text, 'faq'::text])))
);

ALTER TABLE public.pages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.service_translations (
    id bigint NOT NULL,
    service_id bigint NOT NULL,
    lang_code text NOT NULL,
    kind text NOT NULL,
    description text NOT NULL,
    features text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT service_translations_features_len CHECK (((cardinality(features) >= 1) AND (cardinality(features) <= 5)))
);

ALTER TABLE public.service_translations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.service_translations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.services (
    id bigint NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    url text,
    accent text DEFAULT 'blue'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'soon'::text NOT NULL,
    CONSTRAINT services_accent_valid CHECK ((accent = ANY (ARRAY['turquoise'::text, 'blue'::text, 'sky'::text, 'mint'::text]))),
    CONSTRAINT services_status_valid CHECK ((status = ANY (ARRAY['live'::text, 'beta'::text, 'development'::text, 'soon'::text]))),
    CONSTRAINT services_url_public CHECK (((url IS NULL) OR (url ~ '^https://'::text)))
);

ALTER TABLE public.services ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.services_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.translations (
    id bigint NOT NULL,
    string_key text NOT NULL,
    lang_code text NOT NULL,
    value text NOT NULL,
    is_html boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.translations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.translations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.faq_translations
    ADD CONSTRAINT faq_translations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.faq_translations
    ADD CONSTRAINT faq_translations_unique UNIQUE (faq_id, lang_code);

ALTER TABLE ONLY public.faqs
    ADD CONSTRAINT faqs_faq_key_key UNIQUE (faq_key);

ALTER TABLE ONLY public.faqs
    ADD CONSTRAINT faqs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.languages
    ADD CONSTRAINT languages_pkey PRIMARY KEY (code);

ALTER TABLE ONLY public.page_translations
    ADD CONSTRAINT page_translations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.page_translations
    ADD CONSTRAINT page_translations_slug_unique UNIQUE (lang_code, slug);

ALTER TABLE ONLY public.page_translations
    ADD CONSTRAINT page_translations_unique UNIQUE (page_id, lang_code);

ALTER TABLE ONLY public.pages
    ADD CONSTRAINT pages_page_key_key UNIQUE (page_key);

ALTER TABLE ONLY public.pages
    ADD CONSTRAINT pages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.service_translations
    ADD CONSTRAINT service_translations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.service_translations
    ADD CONSTRAINT service_translations_unique UNIQUE (service_id, lang_code);

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_slug_key UNIQUE (slug);

ALTER TABLE ONLY public.translations
    ADD CONSTRAINT translations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.translations
    ADD CONSTRAINT translations_unique_key_lang UNIQUE (string_key, lang_code);

CREATE INDEX contact_messages_created_idx ON public.contact_messages USING btree (created_at DESC);

CREATE INDEX contact_messages_status_idx ON public.contact_messages USING btree (status, created_at DESC);

CREATE INDEX faqs_topic_idx ON public.faqs USING btree (topic, sort_order);

CREATE UNIQUE INDEX languages_single_default ON public.languages USING btree (is_default) WHERE is_default;

CREATE INDEX translations_lang_idx ON public.translations USING btree (lang_code);

CREATE TRIGGER faq_translations_touch_updated_at BEFORE UPDATE ON public.faq_translations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER faqs_touch_updated_at BEFORE UPDATE ON public.faqs FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER languages_touch_updated_at BEFORE UPDATE ON public.languages FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER page_translations_touch_updated_at BEFORE UPDATE ON public.page_translations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER pages_touch_updated_at BEFORE UPDATE ON public.pages FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER service_translations_touch_updated_at BEFORE UPDATE ON public.service_translations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER services_touch_updated_at BEFORE UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER translations_touch_updated_at BEFORE UPDATE ON public.translations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_lang_code_fkey FOREIGN KEY (lang_code) REFERENCES public.languages(code) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.faq_translations
    ADD CONSTRAINT faq_translations_faq_id_fkey FOREIGN KEY (faq_id) REFERENCES public.faqs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.faq_translations
    ADD CONSTRAINT faq_translations_lang_code_fkey FOREIGN KEY (lang_code) REFERENCES public.languages(code) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.faqs
    ADD CONSTRAINT faqs_page_key_fkey FOREIGN KEY (page_key) REFERENCES public.pages(page_key) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.page_translations
    ADD CONSTRAINT page_translations_lang_code_fkey FOREIGN KEY (lang_code) REFERENCES public.languages(code) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.page_translations
    ADD CONSTRAINT page_translations_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pages
    ADD CONSTRAINT pages_service_slug_fkey FOREIGN KEY (service_slug) REFERENCES public.services(slug) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.service_translations
    ADD CONSTRAINT service_translations_lang_code_fkey FOREIGN KEY (lang_code) REFERENCES public.languages(code) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.service_translations
    ADD CONSTRAINT service_translations_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.translations
    ADD CONSTRAINT translations_lang_code_fkey FOREIGN KEY (lang_code) REFERENCES public.languages(code) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.faq_translations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.faqs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.languages ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.page_translations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.pages ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.service_translations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.translations ENABLE ROW LEVEL SECURITY;
