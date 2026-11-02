import type { Knex } from "knex";

// Signals retired (Marcelo 2026-10-27): its tables and the settings only it and Pluto's Edge Margin and model read are dropped,
// about a week after the staging release so a rollback to the previous code stayed possible until then:
//   tables  day_signal_roll_grades, day_signal_quotes, day_signal_expiries, day_signal_rerank_state, signal_model_predictions, signal_settings, option_quote_snapshots, option_surface_fits, option_chain_snapshots
//   columns pluto_settings: 39 Edge Margin, model, strategy and actions-cap fields; shortlist_entries.signals_enabled;
//           trading_settings.min_annualized_yield_pct (the percentages range check is recreated without it: Postgres would
//           otherwise drop the whole check with the column)
// Kept: pluto_decisions, pluto_prompts and pluto_candidate_outcomes (past model rounds, Marcelo 2026-10-27), the backtest LLM
// call tables (past llm sessions stay readable), the volatility model tables (the Baseline wheel's valuation).
// down() recreates the schema only (from the dev database's pg_dump, 2026-10-27); the dropped rows do not come back.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTable("day_signal_roll_grades");
  await knex.schema.dropTable("day_signal_quotes");
  await knex.schema.dropTable("day_signal_expiries");
  await knex.schema.dropTable("day_signal_rerank_state");
  await knex.schema.dropTable("signal_model_predictions");
  await knex.schema.dropTable("signal_settings");
  await knex.schema.dropTable("option_quote_snapshots");
  await knex.schema.dropTable("option_surface_fits");
  await knex.schema.dropTable("option_chain_snapshots");
  await knex.raw(`ALTER TABLE pluto_settings DROP COLUMN max_ticker_pct_of_budget, DROP COLUMN max_sector_pct_of_budget, DROP COLUMN max_open_positions, DROP COLUMN max_actions_per_session, DROP COLUMN order_size_pct_of_budget, DROP COLUMN min_cash_reserve_pct, DROP COLUMN min_grade, DROP COLUMN min_edge_yield_pct, DROP COLUMN max_abs_delta, DROP COLUMN min_dte, DROP COLUMN max_dte, DROP COLUMN min_annualized_yield_pct, DROP COLUMN max_spread_pct, DROP COLUMN min_open_interest, DROP COLUMN min_session_volume, DROP COLUMN max_contracts_volume_share_pct, DROP COLUMN max_slice_rmse_vp, DROP COLUMN min_slice_point_count, DROP COLUMN max_mid_vs_surface_iv_vp, DROP COLUMN max_iv_shift_vp, DROP COLUMN spy_stress_breaker_pct, DROP COLUMN max_edge_margin_drift_pts, DROP COLUMN ticker_cooldown_minutes, DROP COLUMN model_id, DROP COLUMN reasoning_effort, DROP COLUMN call_timeout_seconds, DROP COLUMN daily_cost_ceiling_usd, DROP COLUMN confidence_floor, DROP COLUMN consecutive_model_failures_breaker, DROP COLUMN prompt_version, DROP COLUMN per_ticker_model_cooldown_minutes, DROP COLUMN message_rate_limit_per_second, DROP COLUMN unstructured_close_min_pct, DROP COLUMN unstructured_close_min_dollars, DROP COLUMN buyback_min_dte, DROP COLUMN max_day_move_multiple, DROP COLUMN stress_risk_budget_pct, DROP COLUMN stress_sigmas, DROP COLUMN execution_strategy`);
  await knex.raw("ALTER TABLE shortlist_entries DROP COLUMN signals_enabled");
  await knex.raw("ALTER TABLE trading_settings DROP CONSTRAINT trading_settings_percentages_in_range");
  await knex.raw("ALTER TABLE trading_settings DROP COLUMN min_annualized_yield_pct");
  await knex.raw("ALTER TABLE trading_settings ADD CONSTRAINT trading_settings_percentages_in_range CHECK (max_order_pct_of_portfolio >= 0 AND max_order_pct_of_portfolio <= 100 AND max_concentration_per_ticker_pct >= 0 AND max_concentration_per_ticker_pct <= 100 AND min_cash_reserve_pct >= 0 AND min_cash_reserve_pct <= 100 AND commission_warn_share_of_premium_pct >= 0 AND commission_warn_share_of_premium_pct <= 100)");
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("ALTER TABLE trading_settings DROP CONSTRAINT trading_settings_percentages_in_range");
  await knex.raw("ALTER TABLE trading_settings ADD COLUMN min_annualized_yield_pct numeric(5,2) NOT NULL DEFAULT 50");
  await knex.raw("ALTER TABLE trading_settings ALTER COLUMN min_annualized_yield_pct DROP DEFAULT");
  await knex.raw("ALTER TABLE trading_settings ADD CONSTRAINT trading_settings_percentages_in_range CHECK (max_order_pct_of_portfolio >= 0 AND max_order_pct_of_portfolio <= 100 AND max_concentration_per_ticker_pct >= 0 AND max_concentration_per_ticker_pct <= 100 AND min_cash_reserve_pct >= 0 AND min_cash_reserve_pct <= 100 AND min_annualized_yield_pct >= 0 AND min_annualized_yield_pct <= 100 AND commission_warn_share_of_premium_pct >= 0 AND commission_warn_share_of_premium_pct <= 100)");
  await knex.raw("ALTER TABLE shortlist_entries ADD COLUMN signals_enabled boolean NOT NULL DEFAULT false");
  await knex.raw(`ALTER TABLE pluto_settings
    ADD COLUMN max_ticker_pct_of_budget numeric(6,2) NOT NULL DEFAULT '10'::numeric,
    ADD COLUMN max_sector_pct_of_budget numeric(6,2) NOT NULL DEFAULT '100'::numeric,
    ADD COLUMN max_open_positions integer NOT NULL DEFAULT 15,
    ADD COLUMN max_actions_per_session integer NOT NULL DEFAULT 10,
    ADD COLUMN order_size_pct_of_budget numeric(6,2) NOT NULL DEFAULT '10'::numeric,
    ADD COLUMN min_cash_reserve_pct numeric(6,2) NOT NULL DEFAULT '5'::numeric,
    ADD COLUMN min_grade text NOT NULL DEFAULT 'good'::text,
    ADD COLUMN min_edge_yield_pct numeric(10,2) NOT NULL DEFAULT '15'::numeric,
    ADD COLUMN max_abs_delta numeric(6,4) NOT NULL DEFAULT 0.3,
    ADD COLUMN min_dte integer NOT NULL DEFAULT 2,
    ADD COLUMN max_dte integer NOT NULL DEFAULT 45,
    ADD COLUMN min_annualized_yield_pct numeric(6,2) NOT NULL DEFAULT '50'::numeric,
    ADD COLUMN max_spread_pct numeric(6,2) NOT NULL DEFAULT '15'::numeric,
    ADD COLUMN min_open_interest integer NOT NULL DEFAULT 500,
    ADD COLUMN min_session_volume integer NOT NULL DEFAULT 50,
    ADD COLUMN max_contracts_volume_share_pct numeric(6,2) NOT NULL DEFAULT '20'::numeric,
    ADD COLUMN max_slice_rmse_vp numeric(6,2) NOT NULL DEFAULT '2'::numeric,
    ADD COLUMN min_slice_point_count integer NOT NULL DEFAULT 10,
    ADD COLUMN max_mid_vs_surface_iv_vp numeric(6,2) NOT NULL DEFAULT '5'::numeric,
    ADD COLUMN max_iv_shift_vp numeric(6,2) NOT NULL DEFAULT '8'::numeric,
    ADD COLUMN spy_stress_breaker_pct numeric(6,2) NOT NULL DEFAULT '3'::numeric,
    ADD COLUMN max_edge_margin_drift_pts numeric(6,2) NOT NULL DEFAULT '10'::numeric,
    ADD COLUMN ticker_cooldown_minutes integer NOT NULL DEFAULT 60,
    ADD COLUMN model_id text NOT NULL DEFAULT 'openai/gpt-6-luna'::text,
    ADD COLUMN reasoning_effort text NOT NULL DEFAULT 'medium'::text,
    ADD COLUMN call_timeout_seconds integer NOT NULL DEFAULT 90,
    ADD COLUMN daily_cost_ceiling_usd numeric(8,2) NOT NULL DEFAULT '1'::numeric,
    ADD COLUMN confidence_floor numeric(4,2) NOT NULL DEFAULT 0.6,
    ADD COLUMN consecutive_model_failures_breaker integer NOT NULL DEFAULT 3,
    ADD COLUMN prompt_version text NOT NULL DEFAULT 'v4.5'::text,
    ADD COLUMN per_ticker_model_cooldown_minutes integer NOT NULL DEFAULT 5,
    ADD COLUMN message_rate_limit_per_second integer NOT NULL DEFAULT 8,
    ADD COLUMN unstructured_close_min_pct numeric(6,2) NOT NULL DEFAULT '1'::numeric,
    ADD COLUMN unstructured_close_min_dollars numeric(10,2) NOT NULL DEFAULT '50'::numeric,
    ADD COLUMN buyback_min_dte integer NOT NULL DEFAULT 2,
    ADD COLUMN max_day_move_multiple numeric(6,2) NOT NULL DEFAULT '3'::numeric,
    ADD COLUMN stress_risk_budget_pct numeric(6,2) NOT NULL DEFAULT '1'::numeric,
    ADD COLUMN stress_sigmas numeric(6,2) NOT NULL DEFAULT '2'::numeric,
    ADD COLUMN execution_strategy text NOT NULL DEFAULT 'cc_put_ladder'::text`);
  await knex.raw("ALTER TABLE pluto_settings ADD CONSTRAINT pluto_settings_execution_strategy_check CHECK (execution_strategy = ANY (ARRAY['edge_margin'::text, 'cc_put_ladder'::text]))");
  await knex.raw(`CREATE TABLE public.day_signal_expiries (\n    ticker_id uuid NOT NULL,\n    expiry date NOT NULL,\n    trading_date date NOT NULL,\n    snapshot_id uuid NOT NULL,\n    rank integer NOT NULL,\n    seed_best_expected_pnl_dollars numeric(14,4) NOT NULL,\n    seed_best_edge_margin numeric(10,6) NOT NULL,\n    seeded_at timestamp with time zone NOT NULL\n);`);
  await knex.raw("CREATE TABLE public.day_signal_quotes (\n    ticker_id uuid NOT NULL,\n    expiry date NOT NULL,\n    strike numeric(12,4) NOT NULL,\n    option_right character(1) NOT NULL,\n    trading_date date NOT NULL,\n    bid numeric(12,4),\n    ask numeric(12,4),\n    last numeric(12,4),\n    error_code integer,\n    quoted_at timestamp with time zone NOT NULL,\n    cycle_number integer NOT NULL,\n    last_grade text,\n    CONSTRAINT day_signal_quotes_grade_check CHECK (((last_grade IS NULL) OR (last_grade = ANY (ARRAY['strong'::text, 'good'::text, 'weak'::text, 'avoid'::text])))),\n    CONSTRAINT day_signal_quotes_right_check CHECK ((option_right = ANY (ARRAY['C'::bpchar, 'P'::bpchar])))\n);");
  await knex.raw("CREATE TABLE public.day_signal_rerank_state (\n    ticker_id uuid NOT NULL,\n    trading_date date NOT NULL,\n    reference_spot_price numeric(14,4) NOT NULL,\n    rerank_count integer NOT NULL,\n    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,\n    first_seen_at timestamp with time zone,\n    last_look_at timestamp with time zone,\n    last_look_kind text,\n    CONSTRAINT day_signal_rerank_state_last_look_kind_check CHECK (((last_look_kind IS NULL) OR (last_look_kind = ANY (ARRAY['price'::text, 'timed'::text]))))\n);");
  await knex.raw("CREATE TABLE public.day_signal_roll_grades (\n    ticker_id uuid NOT NULL,\n    leg_id uuid NOT NULL,\n    expiry date NOT NULL,\n    strike numeric(12,4) NOT NULL,\n    option_right character(1) NOT NULL,\n    trading_date date NOT NULL,\n    last_grade text NOT NULL,\n    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,\n    CONSTRAINT day_signal_roll_grades_grade_check CHECK ((last_grade = ANY (ARRAY['strong'::text, 'good'::text, 'weak'::text, 'avoid'::text]))),\n    CONSTRAINT day_signal_roll_grades_right_check CHECK ((option_right = ANY (ARRAY['C'::bpchar, 'P'::bpchar])))\n);");
  await knex.raw("CREATE TABLE public.option_chain_snapshots (\n    id uuid DEFAULT gen_random_uuid() NOT NULL,\n    ticker_id uuid NOT NULL,\n    trading_date date NOT NULL,\n    captured_at timestamp with time zone NOT NULL,\n    underlying_price numeric(14,4),\n    risk_free_rate_percent numeric(8,4),\n    next_ex_dividend_date date,\n    next_ex_dividend_amount numeric(12,4),\n    reference_implied_volatility numeric(10,6),\n    market_data_type text DEFAULT 'unknown'::text NOT NULL,\n    contracts_requested integer DEFAULT 0 NOT NULL,\n    contracts_with_any_tick integer DEFAULT 0 NOT NULL,\n    contracts_with_two_sided_quote integer DEFAULT 0 NOT NULL,\n    contracts_with_implied_volatility integer DEFAULT 0 NOT NULL,\n    capture_duration_ms integer,\n    status text NOT NULL,\n    error_message text,\n    fit_completed_at timestamp with time zone,\n    fit_issue text\n);");
  await knex.raw("CREATE TABLE public.option_quote_snapshots (\n    snapshot_id uuid NOT NULL,\n    expiry date NOT NULL,\n    strike numeric(12,4) NOT NULL,\n    option_right character(1) NOT NULL,\n    bid numeric(12,4),\n    ask numeric(12,4),\n    last numeric(12,4),\n    bid_size integer,\n    ask_size integer,\n    implied_volatility numeric(10,6),\n    delta numeric(10,6),\n    gamma numeric(10,6),\n    vega numeric(10,6),\n    theta numeric(10,6),\n    model_option_price numeric(12,4),\n    underlying_price numeric(14,4),\n    open_interest integer,\n    volume integer,\n    CONSTRAINT option_quote_snapshots_right_check CHECK ((option_right = ANY (ARRAY['C'::bpchar, 'P'::bpchar])))\n);");
  await knex.raw("CREATE TABLE public.option_surface_fits (\n    id uuid DEFAULT gen_random_uuid() NOT NULL,\n    snapshot_id uuid NOT NULL,\n    expiry date NOT NULL,\n    years_to_expiry numeric(10,6) NOT NULL,\n    forward_price numeric(14,4) NOT NULL,\n    status text NOT NULL,\n    point_count integer NOT NULL,\n    dropped_counts jsonb NOT NULL,\n    rmse_volatility numeric(8,6),\n    min_butterfly_density numeric(12,4),\n    k_min numeric(9,5),\n    k_max numeric(9,5),\n    param_a numeric(14,8),\n    param_b numeric(14,8),\n    param_rho numeric(10,8),\n    param_m numeric(12,8),\n    param_sigma numeric(12,8),\n    calendar_checks integer DEFAULT 0 NOT NULL,\n    calendar_violations integer DEFAULT 0 NOT NULL,\n    fitted_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,\n    underlying_price numeric(14,4),\n    CONSTRAINT option_surface_fits_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'insufficient_points'::text, 'fit_failed'::text, 'poor_fit'::text, 'butterfly_arbitrage'::text])))\n);");
  await knex.raw("CREATE TABLE public.signal_model_predictions (\n    id bigint NOT NULL,\n    ticker_id uuid NOT NULL,\n    trading_date date NOT NULL,\n    expiry date NOT NULL,\n    strike numeric(12,4) NOT NULL,\n    option_right character(1) NOT NULL,\n    valued_at timestamp with time zone NOT NULL,\n    quote_source text NOT NULL,\n    bid numeric(12,4) NOT NULL,\n    ask numeric(12,4) NOT NULL,\n    spot numeric(14,4) NOT NULL,\n    forward numeric(14,4) NOT NULL,\n    forecast_volatility numeric(10,6) NOT NULL,\n    variance_sessions numeric(10,4) NOT NULL,\n    fair_price numeric(12,4) NOT NULL,\n    edge_margin numeric(14,6) NOT NULL,\n    expected_pnl_dollars numeric(12,2) NOT NULL,\n    calibrated_expected_pnl_dollars numeric(12,2) NOT NULL,\n    probability_of_profit numeric(8,6) NOT NULL,\n    expected_shortfall_dollars numeric(12,2) NOT NULL,\n    grade text NOT NULL,\n    tables_built_at text NOT NULL,\n    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,\n    CONSTRAINT signal_model_predictions_right_check CHECK ((option_right = ANY (ARRAY['C'::bpchar, 'P'::bpchar])))\n);");
  await knex.raw(`CREATE SEQUENCE public.signal_model_predictions_id_seq\n    START WITH 1\n    INCREMENT BY 1\n    NO MINVALUE\n    NO MAXVALUE\n    CACHE 1;`);
  await knex.raw(`ALTER SEQUENCE public.signal_model_predictions_id_seq OWNED BY public.signal_model_predictions.id;`);
  await knex.raw("CREATE TABLE public.signal_settings (\n    id uuid DEFAULT gen_random_uuid() NOT NULL,\n    max_delta_drift_pct numeric(5,2) NOT NULL,\n    min_annualized_yield_pct numeric(5,2) NOT NULL,\n    max_net_delta numeric(5,4) NOT NULL,\n    max_position_pct_of_portfolio numeric(5,2) NOT NULL,\n    max_concentration_per_ticker_pct numeric(5,2) NOT NULL,\n    min_cash_reserve_pct numeric(5,2) NOT NULL,\n    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,\n    updated_by_user_id uuid,\n    commission_warn_share_of_premium_pct numeric(5,2) DEFAULT '5'::numeric NOT NULL\n);");
  await knex.raw("ALTER TABLE ONLY public.signal_model_predictions ALTER COLUMN id SET DEFAULT nextval('public.signal_model_predictions_id_seq'::regclass);");
  await knex.raw(`ALTER TABLE ONLY public.day_signal_expiries\n    ADD CONSTRAINT day_signal_expiries_pkey PRIMARY KEY (ticker_id, expiry);`);
  await knex.raw(`ALTER TABLE ONLY public.day_signal_quotes\n    ADD CONSTRAINT day_signal_quotes_pkey PRIMARY KEY (ticker_id, expiry, strike, option_right);`);
  await knex.raw(`ALTER TABLE ONLY public.day_signal_rerank_state\n    ADD CONSTRAINT day_signal_rerank_state_pkey PRIMARY KEY (ticker_id);`);
  await knex.raw(`ALTER TABLE ONLY public.day_signal_roll_grades\n    ADD CONSTRAINT day_signal_roll_grades_pkey PRIMARY KEY (leg_id, expiry, strike, option_right);`);
  await knex.raw(`ALTER TABLE ONLY public.option_chain_snapshots\n    ADD CONSTRAINT option_chain_snapshots_pkey PRIMARY KEY (id);`);
  await knex.raw(`ALTER TABLE ONLY public.option_chain_snapshots\n    ADD CONSTRAINT option_chain_snapshots_ticker_id_trading_date_unique UNIQUE (ticker_id, trading_date);`);
  await knex.raw(`ALTER TABLE ONLY public.option_quote_snapshots\n    ADD CONSTRAINT option_quote_snapshots_pkey PRIMARY KEY (snapshot_id, expiry, strike, option_right);`);
  await knex.raw(`ALTER TABLE ONLY public.option_surface_fits\n    ADD CONSTRAINT option_surface_fits_pkey PRIMARY KEY (id);`);
  await knex.raw(`ALTER TABLE ONLY public.option_surface_fits\n    ADD CONSTRAINT option_surface_fits_snapshot_id_expiry_unique UNIQUE (snapshot_id, expiry);`);
  await knex.raw(`ALTER TABLE ONLY public.signal_model_predictions\n    ADD CONSTRAINT signal_model_predictions_pkey PRIMARY KEY (id);`);
  await knex.raw(`ALTER TABLE ONLY public.signal_model_predictions\n    ADD CONSTRAINT signal_model_predictions_ticker_id_trading_date_expiry_strike_o UNIQUE (ticker_id, trading_date, expiry, strike, option_right);`);
  await knex.raw(`ALTER TABLE ONLY public.signal_settings\n    ADD CONSTRAINT signal_settings_pkey PRIMARY KEY (id);`);
  await knex.raw(`CREATE INDEX day_signal_expiries_trading_date_index ON public.day_signal_expiries USING btree (trading_date);`);
  await knex.raw(`CREATE INDEX day_signal_quotes_ticker_id_trading_date_index ON public.day_signal_quotes USING btree (ticker_id, trading_date);`);
  await knex.raw(`CREATE INDEX day_signal_roll_grades_ticker_id_trading_date_index ON public.day_signal_roll_grades USING btree (ticker_id, trading_date);`);
  await knex.raw(`CREATE INDEX option_chain_snapshots_trading_date_index ON public.option_chain_snapshots USING btree (trading_date);`);
  await knex.raw(`CREATE INDEX signal_model_predictions_trading_date_index ON public.signal_model_predictions USING btree (trading_date);`);
  await knex.raw(`ALTER TABLE ONLY public.day_signal_expiries\n    ADD CONSTRAINT day_signal_expiries_snapshot_id_foreign FOREIGN KEY (snapshot_id) REFERENCES public.option_chain_snapshots(id) ON DELETE CASCADE;`);
  await knex.raw(`ALTER TABLE ONLY public.day_signal_expiries\n    ADD CONSTRAINT day_signal_expiries_ticker_id_foreign FOREIGN KEY (ticker_id) REFERENCES public.tickers(id);`);
  await knex.raw(`ALTER TABLE ONLY public.day_signal_quotes\n    ADD CONSTRAINT day_signal_quotes_ticker_id_foreign FOREIGN KEY (ticker_id) REFERENCES public.tickers(id);`);
  await knex.raw(`ALTER TABLE ONLY public.day_signal_rerank_state\n    ADD CONSTRAINT day_signal_rerank_state_ticker_id_foreign FOREIGN KEY (ticker_id) REFERENCES public.tickers(id);`);
  await knex.raw(`ALTER TABLE ONLY public.day_signal_roll_grades\n    ADD CONSTRAINT day_signal_roll_grades_leg_id_foreign FOREIGN KEY (leg_id) REFERENCES public.position_legs(id) ON DELETE CASCADE;`);
  await knex.raw(`ALTER TABLE ONLY public.day_signal_roll_grades\n    ADD CONSTRAINT day_signal_roll_grades_ticker_id_foreign FOREIGN KEY (ticker_id) REFERENCES public.tickers(id);`);
  await knex.raw(`ALTER TABLE ONLY public.option_chain_snapshots\n    ADD CONSTRAINT option_chain_snapshots_ticker_id_foreign FOREIGN KEY (ticker_id) REFERENCES public.tickers(id);`);
  await knex.raw(`ALTER TABLE ONLY public.option_quote_snapshots\n    ADD CONSTRAINT option_quote_snapshots_snapshot_id_foreign FOREIGN KEY (snapshot_id) REFERENCES public.option_chain_snapshots(id) ON DELETE CASCADE;`);
  await knex.raw(`ALTER TABLE ONLY public.option_surface_fits\n    ADD CONSTRAINT option_surface_fits_snapshot_id_foreign FOREIGN KEY (snapshot_id) REFERENCES public.option_chain_snapshots(id) ON DELETE CASCADE;`);
  await knex.raw(`ALTER TABLE ONLY public.signal_model_predictions\n    ADD CONSTRAINT signal_model_predictions_ticker_id_foreign FOREIGN KEY (ticker_id) REFERENCES public.tickers(id);`);
  await knex.raw(`ALTER TABLE ONLY public.signal_settings\n    ADD CONSTRAINT signal_settings_updated_by_user_id_foreign FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id);`);
}
