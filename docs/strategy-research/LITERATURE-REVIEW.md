# CC + Put Ladder: what published research says

A review, done on 2026-10-20, of academic papers, practitioner backtests, option-income funds and informal sources, read against what our own backtests found. The question was what might raise the CC + Put Ladder's CAGR or cut its Max drawdown.

Related files:
- [BACKTEST-FINDINGS.md](BACKTEST-FINDINGS.md): our own results.
- [IDEAS-TO-TRY.md](IDEAS-TO-TRY.md): the ideas this review produced, with test designs and status.

Published report: [Ladder Strategy Ideas](https://claude.ai/artifact/CAQhQ1myv575QkadVGtUqD). Where this file and that page differ, this file is the corrected one:
- **Spintwig counts.** Re-checked against the scorecard export on 2026-10-20.
  - Holding to expiry won 66 of the 79 ticker × delta pairs that have both figures. The page says 68 of 81.
  - GE's Puts made money at 5 delta.
- **Two shortlist ideas** clashed with decisions Marcelo had already made. [IDEAS-TO-TRY.md](IDEAS-TO-TRY.md) reframes them (I-04 and I-05).

## How the review was done

- **Six research threads ran in parallel:**
  - academic research on option selling;
  - practitioner backtests of trade management;
  - the wheel, averaging down and repair;
  - drawdown control and sizing;
  - stock selection and timing signals;
  - informal sources and option-income funds.
- **Coverage was limited by the search cap.** The threads shared a cap of about 200 web searches, so each stopped early, after 6 to 46 searches.
  - Many sources were read only as abstracts or summaries, and each item below says so where it matters.
  - "Full text" means a thread read the paper itself. PDFs were saved, and their text was extracted with pypdf.
- **Labels and terms:**
  - Journals are peer-reviewed: JF (Journal of Finance), JFE (Journal of Financial Economics), RFS (Review of Financial Studies), JFQA (Journal of Financial and Quantitative Analysis), FAJ (Financial Analysts Journal), JPM (Journal of Portfolio Management).
  - "Working paper", arXiv, SSRN, and papers from Cboe, AQR or other firms are not peer-reviewed.
  - Spintwig's "Sharpe" is CAGR ÷ volatility with no T-bill deduction.
  - "16 delta" means \|delta\| 0.16.
- **What the evidence covers.** Most of it is on index options or broad single-stock samples from 1986 to 2019. Little covers 2020 to 2026, or high-volatility single stocks sold without a hedge, which is what we do.

## Plain-language summary

1. **The option-selling premium is reliable on indexes and weak on single stocks.** One study found it significant in dollar terms for only 3 of 35 stocks, against strongly significant for the S&P 500.
2. **On single stocks, the richest options sit on the stocks that do worst afterwards.** These are volatile, lottery-like, distressed, hard-to-short names. A seller who hedges keeps the richness; a wheel that doesn't hedge also takes the stock's poor returns and crashes. That fits our finding that the plain wheel has no edge.
3. **Wheels and option-income funds give up CAGR for a shallower Max drawdown, and end about level with buy and hold.**
   - The one product that beat its index was Cboe's index put-writing (PUT), from 1986 to 2018 and before costs: almost the same CAGR as the S&P 500, with a Max drawdown of −32.7% against −50.9%.
   - Since 2006 its CAGR has lagged the index: 5.97% against 7.59%, to 2018. Its Excess Calmar stayed slightly ahead, because of the shallower Max drawdown.
4. **A higher annualized premium is not a higher profit.** Cboe's weekly put-writing index collected 39.3% a year in premium against 24.1% for the monthly one, yet compounded less: 5.6% against 6.6%. Our ranking by annualized premium yield leans toward the shortest, widest-spread and most lottery-like contracts.
5. **The ladder's "buy more as it falls" is a bet the research says isn't paid.**
   - AQR measured the same exposure inside a Covered Call at about a quarter of its risk, for little return.
   - Momentum research finds that 3–12-month losers keep losing.
   - No study tests a put ladder directly. And in our own order data, ladder Puts sold during downtrends were not followed by more falls (see section 3).
6. **Once shares are stuck below cost, the price paid is irrelevant to what the next Call is worth.** The rule "never sell a Call below cost" has no data behind it.
7. **What doesn't work in the evidence:**
   - stop-losses on the options;
   - closing at 50% profit;
   - collars, protective Puts and tail hedges;
   - stock repair;
   - rolling (it equals a strike rule);
   - leverage.

## 1. Where the premium is

**Index options carry a reliable premium; single stocks carry much less.**
- [Carr & Wu, Variance Risk Premiums](https://engineering.nyu.edu/sites/default/files/2019-01/CarrReviewofFinStudiesMarch2009-a.pdf) (RFS 2009; full text of the 2004 version; 1996–2003):
  - The premium was strongly significant for the S&P 500, S&P 100 and Dow. Variance buyers lost more than 50% a month in log excess return.
  - It was much smaller for the Nasdaq-100 and for 35 single stocks: the log premium was significant for 21 of 35, the dollar premium for only 3.
  - A stock's premium rises with how closely its variance moves with the S&P's.
- [Driessen, Maenhout & Vilkov, The Price of Correlation Risk](https://ideas.repec.org/a/bla/jfinan/v64y2009i3p1377-1406.html) (JF 2009; the [2013 version](https://www.netspar.nl/wp-content/uploads/061_Driessen.pdf) read):
  - On the S&P 500 in 1996–2012, average implied correlation was 39.5%, against about 32.5% realized.
  - "Individual variance risk is not priced on average." The index premium is a premium for correlation risk.
- [Bondarenko for Cboe](https://cdn.cboe.com/resources/education/research_publications/PutWriteCBOE19_v14_by_Prof_Oleg_Bondarenko_as_of_June_14.pdf) (2019; paid for by Cboe; before costs). PUT is one-month at-the-money S&P 500 Cash-Secured Puts.
  - From 1986 to 2018: CAGR 9.54% against 9.80% for the S&P 500; volatility 9.95% against 14.93%; Max drawdown −32.7% against −50.9%.
  - The VIX averaged 19.3% while actual volatility averaged 15.1% (1990–2018).
  - [GMO 2018](https://www.gmo.com/globalassets/articles/insights/global-equity/2018/ncvl_value-of-short-volatility-strategies_2-18.pdf): PUT's Max drawdown was shallower than the S&P's in all four sell-offs (2008: −37.1% against −55.3%).
- **Spintwig scorecard** ([Options Scorecard](https://spintwig.com/options-scorecard/), archived copies; 45-day Puts held to expiry; re-checked against the 595-row export):
  - Positive Sharpe at every delta on SPY, IWM, TLT, EEM, GLD and SLV.
  - Single stocks were mostly positive (AAPL, AMZN, DIS, MU, T, TSLA, VZ). The exceptions:
    - C was negative at every delta (−0.20 to −0.02), and so was USO (−0.39 to −0.19).
    - GE was positive only at 5 delta (+0.18), and negative from 10 delta up (−0.02 to −0.48).
  - The best Sharpe came at 16 delta or lower on 15 of the 16 underlyings, USO being the exception. TSLA, for example, scored 2.24 at 5 delta against 0.72 at 50.
  - Total return runs the other way: on MU, "higher delta strategies yielded greater total return". A low-delta CAGR can fall below T-bills: the SPY Wheel at 5 delta made 2.89% (section 2).
- [Christoffersen et al.](https://globalriskinstitute.org/publication/illiquidity-premia-in-the-equity-option-market/) (RFS 2018; summary only): end-users are net sellers of single-stock options, and illiquid equity options earn more for their buyers.

**On single stocks, the richest options sit on the worst stocks.**
- **Options side**
  - [Cao & Han](https://www.cxoadvisory.com/volatility-effects/extracting-a-volatility-premium-with-equity-options) (JFE 2013; summary; about 6,000 stocks, 1996–2009): delta-hedged option returns fall as stock-specific volatility rises. The long-short earned about 1–2% a month before costs.
  - [Zhan, Han, Cao & Tong](https://ideas.repec.org/a/oup/rfinst/v35y2022i3p1394-1442..html) (RFS 2022; full text of the 2016 working paper):
    - Delta-hedged Call writing earned 3.92% a month more on the top decile of stock-specific volatility than on the bottom one, and more on heavy share issuers, cash-rich firms and unprofitable firms.
    - Delta-hedged option writing earned 1.3–2.0% a month more on 12-month losers than on winners.
  - [Boyer & Vorkink](https://ideas.repec.org/a/bla/jfinan/v69y2014i4p1485-1527.html) (JF 2014; abstract): option portfolios sorted by expected skewness differ by 10–50% a week, and the most lottery-like earn least for buyers. Overpricing is largest close to expiry, and spreads widen with skewness.
  - Byun & Kim (JFE 2016; abstract): Calls on the most lottery-like stocks returned 10–20% a month less than Calls on the least lottery-like.
  - [Eisdorfer, Goyal & Zhdanov](https://www.sfi.ch/en/publications/n-20-64-cheap-options-are-expensive) (working paper): hedged options on low-priced stocks underperform those on high-priced stocks, by 0.54% a week for Calls and 0.34% for Puts.
- **Stock side**
  - [Bali, Cakici & Whitelaw](https://ideas.repec.org/a/eee/jfinec/v99y2011i2p427-446.html) (JFE 2011; abstract): stocks with the biggest one-day gain in the past month (MAX) underperform by more than 1% a month. This is contested.
  - [Ang, Hodrick, Xing & Zhang](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=681343) (JF 2006): high stock-specific volatility goes with "abysmally low" returns.
  - [Campbell, Hilscher & Szilagyi](https://www.nber.org/papers/w12362) (JF 2008; abstract): distressed stocks have had anomalously low returns since 1981.
  - [Hu & Jacobs](https://ideas.repec.org/a/cup/jfinqa/v55y2020i3p1025-1060_10.html) (JFQA 2020; abstract): unhedged Put returns rise with the stock's volatility. The thread inferred that Put sellers keep less on volatile stocks.
- **Hard-to-short stocks**
  - [Ofek, Richardson & Whitelaw](https://www.nber.org/papers/w9423) (JFE 2004; abstract): put-call parity gaps track the cost of shorting and predict low returns.
  - [Ramachandran & Tayal](https://ideas.repec.org/a/eee/jfinec/v141y2021i1p297-321.html) (JFE 2021; abstract): Puts on overpriced, hard-to-short stocks are expensive. There is no such effect for Calls.
  - When a stock is costly to borrow, the extra Put premium is borrow cost, not free premium. A ranking by premium yield prefers exactly those Puts.
- **What this means for us** (the threads' inference; moderate confidence):
  - A seller who hedges delta keeps the richness. Our Cash-Secured Puts don't hedge, so they also take the stock's drift and its crashes: the PTON, MRNA, DOCN and AAOI pattern.
  - Ranking by the highest annualized yield points at exactly these situations.

**Costs decide whether a cross-sectional edge survives.**
- **Studies that charged part or all of the spread**
  - Cao & Han: the long-short falls to about zero once 50–100% of the quoted spread is paid.
  - [Saretto](https://www.cis.upenn.edu/~mkearns/finread/CrossOptions.pdf) (2005 working paper, the forerunner of Goyal & Saretto; full text; 1996–2005):
    - When at-the-money IV is above both other stocks' IV and the stock's own 12-month average, it falls the next month. Puts in that group returned −12.0% a month to buyers, while the stocks themselves showed no return pattern.
    - Long-short straddles held to expiry made 16.1% at mid, and 5.5% after paying 75% of the spread.
  - [Heston, Jones, Khorram, Li & Mo, Option Momentum](https://www.acem.sjtu.edu.cn/sffs/2021w/pdfs/3.pdf) (JF 2023; full 2021 text; 1996–2019): a Sharpe of 1.53 before costs, near zero after paying the full spread.
  - Vasquez (JFQA 2017): a long-short straddle on the IV term structure made 27.1% a month before costs and 12.3% after.
- **Real costs may be lower.** [Muravyev, Pearson & Van Nieuwerburgh](https://ideas.repec.org/a/oup/rfinst/v33y2020i11p4973-5014..html) (RFS 2020; abstract): traders who time their orders pay effective spreads under 40% of the quoted ones.
- **Our own setting.** We assume fills at the mid (spread cost share 0). Marcelo decided this on 2026-10-15, after testing live fills. The academic cost haircut applies to us only where wide-spread contracts fail to fill at the mid live.

## 2. Wheels, Covered Calls and option-income funds against buy and hold

No rigorous study of the wheel across many single stocks was found. The index evidence:

| Source (type) | Window | Strategy | CAGR | Max drawdown | Buy and hold |
|---|---|---|---|---|---|
| [theoptionsbench](https://theoptionsbench.com/wheel-strategy-backtest/) (practitioner; modelled prices) | 2005–2026 | SPY 30-delta monthly wheel, held to expiry | 7.89% | −35.9% | 10.95%, −55.2% |
| theoptionsbench (real fills) | 2010–2023 | same | 6.84% | −28.4% | 12.84% |
| Spintwig SPY Wheel, 45 days | 2007–2020 | 30 delta | 4.91% | −43.1% | 8.99%, −50.8% |
| | | 50 delta | 4.87% | −42.0% | |
| | | 5 delta | 2.89% | −22.1% | |
| Cboe 30-delta Covered Call index, BXMD ([newsletter citing Cboe](https://wheelstrategy.substack.com/p/wheel-strategy-vs-buy-and-hold-income-vs-growth); its dates are inconsistent) | since 1986 | index Covered Calls | 10.7% | −42.7% | 11.2%, −50.9% |
| Cboe PUT ([theoptionsbench data studies](https://theoptionsbench.com/data-studies/)) | about 19 years | index Cash-Secured Puts | 6.9% | −37% | 10.8%, −55% |

- **theoptionsbench details**
  - Idle cash earned 0%; 2% on cash would add about 1.3–1.4 points a year.
  - Shares were held about 27% of the time, with 24 assignments.
  - SPY's Calls traded at about 14% implied volatility against about 19% for the matching Puts, so the Call leg is the weak one.
  - At about 1.8% T-bills, Excess Calmar is about 0.17 for both the wheel and buy and hold (the thread's arithmetic).
- **Spintwig**
  - CAGR ÷ \|Max drawdown\| was 0.18 for buy and hold against 0.13 for the best wheel (5 delta).
  - The wheel lost to buy and hold in every Spintwig test.
  - A garbled search summary attributes about 94–99% of the SPY wheel's total return to the shares.
- **Other wheel tests**
  - [FlashAlpha](https://flashalpha.com/articles/options-strategies-ranked-light-backtest-spy-qqq-iwm) (vendor; 25-delta 35-day wheel, 2020–2025, no interest on cash): total return of 22.4% on SPY, 21.9% on QQQ and 4.8% on IWM.
  - [QuantConnect](https://www.quantconnect.com/research/17871/automating-the-wheel-strategy/): SPY wheel Sharpe 1.08 against 0.70, with no CAGR or Max drawdown given. A commenter hit a margin call running it over 2007–2011.
- **Single stocks** (thin, old evidence):
  - [27 FTSE-100 stocks, 1994–99](https://link.springer.com/article/10.1057/palgrave.jdhf.1850063): Covered Calls mostly beat buy and hold, though the paper's own Monte Carlo disagreed.
  - [Doran & Fodor](https://www.cxoadvisory.com/equity-options/strategies-for-investing-in-options-of-individual-stocks/) (213 large growth stocks, 1996–2006): stock plus short at-the-money Puts beat stock alone, with the gains tied to stock-specific volatility. Further out-of-the-money short options were not reliably better, because spreads widen in percentage terms. Long Calls added little.
  - [Hemler & Miller](https://prd-web.optionseducation.org/getmedia/c3b5a9b7-2524-4c56-9246-367d03e81e85/perf-options-strategies.pdf) (2015; funded by the Options Industry Council; 10 large caps, 2003–2013): Covered Calls, and stock plus a short Call plus a short Put, beat holding the stock on Sharpe, Jensen, Treynor and Sortino. This holds for large caps only.

**Option-income funds.** Total return with distributions reinvested, up to 2026-10-19 ([totalrealreturns.com](https://totalrealreturns.com/n/TSLY,TSLA) comparison pages). Every window is mostly a bull market, which biases the comparison against selling Calls.

| Fund (method) | From | CAGR, fund against underlying | Max drawdown, fund against underlying |
|---|---|---|---|
| TSLY (synthetic Covered Call on TSLA) | 2022-11 | 7.66% vs 19.57% | −49.5% vs −53.8% |
| NVDY (on NVDA) | 2023-05 | 53.95% vs 79.95% | −34.1% vs −36.9% |
| CONY (on COIN) | 2023-08 | 5.47% vs 26.81% | −67.4% vs −66.4% |
| MSTY (on MSTR) | 2024-02 | 17.58% vs 27.52% | −77.4% vs −82.6% |
| QYLD (at-the-money monthly Calls, 100% covered) | 2013-12 | 8.93% vs 19.05% (QQQ) | −24.8% vs −35.1% |
| QYLD / QYLG (50% covered) | 2020-09 | 10.29% / 14.06% vs 17.99% (QQQ) | −24.6% / −30.0% vs −35.1% |
| XYLD | 2013-06 | 8.42% vs 14.54% (SPY) | −33.5% vs −33.7% |
| RYLD | 2019-04 | 5.21% vs 9.08% (IWM) | −41.5% vs −41.1% |
| SPYI / JEPI / XYLD | 2022-08 | 15.04 / 9.55 / 11.48% vs 18.75% (SPY) | −16.5 / −13.3 / −15.5% vs −18.8% |
| JEPQ / QQQI / QDTE (0-day Calls each morning) | 2024-03 | 16.22 / 17.56 / 19.18% vs 20.69% (QQQ) | −20.1 / −20.0 / −22.9% vs −22.8% |
| QQQY / IWMY (0-day income funds) | 2023-10 | 16.99% vs 28.04% (QQQ); 10.51% vs 19.69% (IWM) | −19.0% vs −22.8%; −18.7% vs −27.5% |
| PUTW (one-month at-the-money SPX Puts until October 2022) | 2016-02 to 2023-12 | 6.62% vs 14.28% (S&P 500) | worst quarter −20.65% (Q1 2020) |
| Cboe PUT index | 1986-06 to 2018 | 9.54% vs 9.80% | −32.7% vs −50.9% |
| Cboe WPUT (weekly) / PUT | 2006 to 2018 | 4.51% / 5.97% vs 7.59% | −24.2% / −32.7% vs −50.9% |

What the funds teach. "≈Excess Calmar" is the thread's arithmetic. Each fund-versus-underlying conclusion holds for any T-bill rate from 0% to 5%.
1. **No income fund beat its underlying on Excess Calmar.**
   - The single-stock funds did worst: they kept only 20–67% of the stock's CAGR, while their Max drawdown stayed within about 5 points of the stock's.
   - At 4% T-bills, ≈Excess Calmar: TSLY 0.07 against TSLA 0.29; CONY 0.02 against COIN 0.34; MSTY 0.18 against MSTR 0.29.
2. **Only index put-writing beat its index.** That is the Cboe PUT index, before costs; the PUTW fund did not.
   - Over 2006–2018, at T-bills of about 1.1%: ≈Excess Calmar 0.15 for PUT, 0.14 for WPUT and 0.13 for the S&P 500.
3. **Calls soften slow bear markets, not crashes.**
   - In 2022: QYLD −19.1% against QQQ −32.6%; XYLD −12.1% against SPY −18.2%; RYLD −13.0% against IWM −20.5%.
   - In the 2020 crash: XYLD −33.5% against −33.7%; RYLD −41.5% against −41.1%.
4. **Covering fewer shares, and selling less often, keeps more CAGR.**
   - At 3% T-bills, ≈Excess Calmar: QYLG 0.37, QYLD 0.30, QQQ 0.43.
   - WPUT collected 37.1% a year in gross premium against 22.1% for PUT, and still compounded more slowly.
5. **JEPI's resilience comes from its stocks, not its Calls.** Its 2022 return of −3.54% (against −18.11% for the S&P 500) comes from low-volatility stocks: a 3-year beta of 0.42, per the [fact sheet](https://am.jpmorgan.com/content/dam/jpm-am-aem/americas/us/en/literature/fact-sheet/etfs/FS-JEPI.pdf). XYLD, fully covered at the money, lost 12.05% that year.

## 3. Averaging down: the research and the ladder

- **AQR measured the same exposure inside a Covered Call.** [Israelov & Nielsen, Covered Calls Uncovered](https://www.aqr.com/Insights/Research/Journal-Article/Covered-Calls-Uncovered) (FAJ 2015; S&P 500 1996–2014; before costs; abstract and [summary](https://www.cxoadvisory.com/equity-options/enhancement-of-index-covered-calls-via-hedging)):
  - A Covered Call is short volatility (Sharpe about 1.0), plus long equity, plus a "buy more as it falls" reversal exposure.
  - That reversal exposure carried about 25% of the risk for little return.
  - Hedging it out raised the Sharpe ratio of BXM (Cboe's at-the-money S&P 500 Covered Call index) from 0.37 to 0.52, and cut its downside beta from 0.85 to 0.60.
  - The ladder is a larger, deliberate version of the same bet.
- **Volatility timing points the other way.** [Moreira & Muir](https://www.nber.org/system/files/working_papers/w22208/w22208.pdf) (JF 2017) note that put selling "mechanically" does the opposite of volatility management.
- **Buy-more rules lose in trends.** [Perold & Sharpe](https://rpc.cfainstitute.org/research/financial-analysts-journal/1988/dynamic-strategies-for-asset-allocation) (FAJ 1988): such rules have concave payoffs and lose in trending markets. The trend point comes from a secondary summary.
- **Momentum**
  - [Jegadeesh & Titman](https://ideas.repec.org/a/bla/jfinan/v48y1993i1p65-91.html) (JF 1993): stocks that lost over 3–12 months keep underperforming for the next 3–12 months.
  - [Moskowitz, Ooi & Pedersen](https://ideas.repec.org/a/eee/jfinec/v104y2012i2p228-250.html) (JFE 2012): trends persist for 1–12 months across 58 futures markets.
  - Counterpoint, Zhan et al. (above): options on losers are richer to sell. Ladder Puts earn more premium, but the shares they buy do worse.
- **Base rates for catastrophic falls**
  - [J.P. Morgan, The Agony & the Ecstasy](https://www.chase.com/content/dam/privatebanking/en/mobile/documents/eotm/eotm_2014_09_02_agonyescstasy.pdf) (Russell 3000, about 13,000 stocks, 1980–2014):
    - 40% fell 70% or more and stayed at least 60% below their peak.
    - By sector: tech 57%, telecom 51%, energy 47%, consumer discretionary 43%, health care 42% (biotech above 50%), utilities 13%.
    - The median stock's lifetime return was 54 points below the index.
  - [Mauboussin & Callahan](https://marcellus.in/story/drawdowns-and-recoveries-base-rates-for-bottoms-and-bounces/) (6,500 stocks, 1985–2024):
    - The median Max drawdown was 85%, and more than half never regained their old high.
    - Larger drawdowns recover less often, though returns off the lows are attractive on average, with a skewed spread.
- **The idle reserve is real capital.** [Hayley](https://openaccess.city.ac.uk/id/eprint/6298/) (Cass 2014): "double down after losses" schemes report an upward-biased return, because the idle reserve is real capital.
- **A practitioner's critique.** [Early Retirement Now (ERN), The Wheel Strategy Doesn't Work](https://earlyretirementnow.com/2024/09/17/the-wheel-strategy-doesnt-work-options-series-part-12/) (2024; opinion and arithmetic):
  - The wheel is "a tactical valuation strategy in disguise". Net delta goes from about 0.2 on a fresh Cash-Secured Put to about 1.0 after assignment, as the Call goes worthless.
  - He criticizes "buying additional stocks to lower the cost basis", citing PTON (−97%).
- **Nothing tests a put ladder directly.** No source tests a put ladder or "DCA with Puts", and the martingale warnings found are opinion.
- **Our own data cuts the other way on one point.** In the 2026-10-19 order study ([BACKTEST-FINDINGS.md](BACKTEST-FINDINGS.md), Round 5, Test 3):
  - Ladder Puts sold while the price was below its 200-day average (about 70% of them) were followed by 30% falls no more often than the others, within each ticker.
  - High IV Rank marked the ladder Puts that fell least.
  - That study measured each Put's own outcome, not what the shares it bought did afterwards. Only a backtest settles whether pausing the ladder helps.

## 4. Shares stuck below cost

- **The price paid doesn't matter to the next Call.** [Israelov & Nielsen, Covered Call Strategies: One Fact and Eight Myths](https://www.aqr.com/-/media/AQR/Documents/Insights/Journal-Article/FAJ-Covered-Call-Strategies-One-Fact-and-Eight-Myths.pdf) (FAJ 2014; full text):
  - Once shares are held, "the initial stock price is irrelevant".
  - An option's profit comes only from implied volatility exceeding what the stock then does (Myths 7 and 8). Strikes chosen by yield or price targets are a side effect.
- **Investors hold losers too long.** [Odean](https://rpc.cfainstitute.org/-/media/documents/article/cfa-digest/1999/dig-v29-n2-469-pdf.pdf) (JF 1998; 10,000 brokerage accounts): the winners they sold beat the losers they kept by about 3.4 points over the next year.
- **Stops cost return unless prices trend.** [Kaminski & Lo, When Do Stop-Loss Rules Stop Losses?](https://dspace.mit.edu/handle/1721.1/114876) (2014): stop rules always lower expected return when prices move randomly. With momentum, they added 50–100 bp a month during stop-out periods.
- **Holding less beats buying protection.** [Israelov, Pathetic Protection](https://images.aqr.com/-/media/AQR/Documents/Journal-Articles/Pathetic-Protection-JAI-Wint19.pdf) (2019): 40% equity and 60% cash matched a Put-protected portfolio's return, with less than half the volatility and better drawdowns.
- **"Never sell Calls below cost basis" is a community rule with no data behind it** in anything found ([Wheel Strategy Substack](https://wheelstrategy.substack.com/p/wheel-strategy-mistakes), [johnnyafrica](https://johnnyafrica.com/option-wheel-strategy/): opinion). [SpotGamma](https://spotgamma.com/covered-calls-below-cost-basis/) (opinion): Calls below cost are a legitimate trade-off, but not right after a crash; beware a "loss-lock spiral".
- **Funds reset their Calls every month.** Income funds sell at the money each month whatever they paid. That softened 2022, not 2020 (section 2).
- **Illustration** (Black-Scholes arithmetic, not evidence): at 80% implied volatility, a 30-day 0.20-delta Call is worth about 2.3% of the share price, and a 0.30-delta Call about 3.9%. Stuck shares earn neither.
- **Rolling is a strike rule.** By put-call parity, a Covered Call at strike K equals a Cash-Secured Put at K with the same expiry. Rolling a losing Put down to K2 therefore gives the same exposure as taking assignment and selling a Call at K2, apart from costs, dividends and early exercise. No measured comparison was found, and the practitioner rules for rolling (net credit only, 2–3 rolls) have no data behind them.

## 5. Calls: how far out, and on how many shares

- **Lower-delta Calls did better on SPY.** Spintwig, SPY short Calls at 45 days, held to expiry (re-checked):

  | Delta | 5 | 10 | 16 | 30 | 50 |
  |---|---|---|---|---|---|
  | Sharpe | 0.26 | 0.12 | 0.00 | −0.15 | −0.27 |

  Every early-exit variant scored 0.00 or below (−1.25 to 0.00).
- **Further out of the money beat at the money on the Russell 2000.** [Kapadia & Szado](https://www.cxoadvisory.com/equity-options/russell-2000-index-buy-write-strategy-performance) (2011 working paper; summary; 1996–2011): one-month Covered Calls had a Sharpe of 0.27 at the money, 0.33 at 2% out of the money and 0.37 at 5%, against 0.23 for the index. Two-month Calls didn't consistently beat the index.
- **Covered Calls give little downside protection.** Israelov & Nielsen 2014 (Table 1, 1986–2013): BXM's upside beta was 0.63 against a downside beta of 0.78, and its Max drawdown −43.0% against −61.7% for the S&P. Their Myth 2: Covered Calls give only "very limited" downside protection, so capping rallies buys little reduction in Max drawdown.
- **Cboe's 30-delta index (BXMD) beat the at-the-money BXM** in two secondary sources:
  - a newsletter citing Cboe factsheets: 10.7% a year against 8.6% since 1986 (its dates are inconsistent);
  - an [MDPI paper](https://www.mdpi.com/2227-7072/12/4/114) seen only as a search summary: about 8.1–8.3% against 6.0%, with return per unit of risk about 0.56 against 0.46.
  - Hill et al. (FAJ 2006; abstract): setting the Call strike by the volatility environment beat BXM's fixed at-the-money rule.
- **SPY's Calls finished in the money more often than their delta implied, and its Puts less often.** [tastytrade presentation](https://s3.amazonaws.com/tastytradepublicmedia/website/cms/tastytrade_TomSosnoff_India2020.pdf/original/tastytrade_TomSosnoff_India2020.pdf) (broker research; SPY at 45 days, about 2010–2020):
  - 30-delta Calls finished in the money 45% of the time against 30% implied, and 16-delta Calls 20% against 16%.
  - 30-delta Puts finished in the money only 11% of the time, against 30% implied.
- **Covering half the shares kept more return.** QYLG covers 50% of the Nasdaq-100 and made 14.06% a year, against 10.29% for QYLD covering 100% (QQQ 17.99%). Single-stock Call funds kept 20–67% of their stock's CAGR (section 2). [Global X](https://globalxetfs.co.jp/en/research/introducing-the-global-x-covered-call-growth-etfs-qylg-xylg/index.html) describes it as about 50% of the upside for half the income, with no data.
- **Buying back some upside.** [SPYI](https://neosfunds.com/spyi/) also buys some far out-of-the-money Calls, and made 15.04% against 11.48% for fully covered XYLD. The gap can't be attributed to the bought Calls.

## 6. Expiry length, annualized yield and costs

- **AQR's Myth 4.** Short-dated and high-volatility options carry higher annualized premiums, but "expected investment profits are generated by the option's richness, not the option's price". Twelve monthly at-the-money options bring in about 3.5 times the cash of one annual option, but not more profit.
- **Weekly against monthly put-writing.** [Cboe release](https://ir.cboe.com/news/news-details/2016/New-Study-On-Weekly-Monthly-SP-500-PutWrite-Indexes-Released-01-27-2016/default.aspx) and [summary](https://www.cxoadvisory.com/equity-options/performance-of-cboe-putwrite-indexes), 2006–2015, before costs:

  | | Weekly (WPUT) | Monthly (PUT) | S&P 500 |
  |---|---|---|---|
  | Premium collected a year | 39.3% | 24.1% | |
  | CAGR | 5.6% | 6.6% | 7.1% |
  | Sharpe | 0.50 | 0.52 | |
  | Max drawdown | −24% | −33% | |
- **Short expiries did worse on Sharpe in Spintwig's tests.** AAPL Puts held to expiry had a Sharpe of 0.05–0.35 at 0 days, against 0.46–0.52 at 45 days, and DIS showed the same pattern. Commissions took a larger share of profits on short expiries:

  | Strategy | Share of profits paid in commissions |
  |---|---|
  | AAPL, 0 days | 20.8% |
  | QQQ, 7 days | 13.8% |
  | QQQ, 45 days | 4.5% |
  | SPY Wheel, 0 days (2018–2021) | 46.2% (unprofitable at every delta except 5) |
  | SPY Wheel, 7 days | 5.6% |
  | SPY Wheel, 45 days | 5.0% |
- **Costs erase most of the edge at short expiries.** FlashAlpha's SPY put-spread matrix (vendor; 2017–2026; 18.3 million model-priced spreads; no costs): 0–7 days made 0.97% per trade (75% annualized), against 2.86% (32% annualized) at 22–45 days. In their words, "a $0.10–0.20 per-share cost budget erases most of the edge at 7 DTE".
- **Expiry may matter more than the exit rule.** [Thetadesk](https://thetadesk.substack.com/p/should-you-close-winners-at-50-i) (modelled SPX prices, no costs): "DTE is a bigger lever than the exit rule".
- **Evidence the other way:**
  - Boyer & Vorkink: lottery-like overpricing is largest close to expiry.
  - Spintwig SPY at 0, 7 and 45 days (2018-02 to 2020-06, 5× leverage): shorter expiries had higher premium capture, win rate and total P&L.
  - ERN: 1-day Puts beat 2-day for him.
  - [Israelov & Tummala](https://www.aqr.com/Insights/Research/Working-Paper/Which-Index-Options-Should-You-Sell) (AQR 2017; page summaries; S&P 1996–2015; delta-hedged): returns were highest for short-maturity, moderately out-of-the-money options.
  - [Dew-Becker et al.](https://pure.psu.edu/en/publications/the-price-of-variance-risk/) (JFE 2017; abstract): only short-term realized variance carries a significant price.
  - [Frazzini & Pedersen](https://nber.org/system/files/working_papers/w18558/w18558.pdf) (NBER 2012): shorter-dated, further out-of-the-money options embed more leverage and have significantly negative alphas for buyers.
- **Caveat:** before about 2016, single-stock 0-day entries existed only near monthly expiries.
- **For us:**
  - Our ranking leans to 1–7-day contracts, and the lab allows spreads up to 50% of mid.
  - Marcelo decided on 2026-10-08, for Pluto, to keep short-dated contracts (2-day included) for their yield and to size their risk, not exclude them.

## 7. Managing the trade: profit-taking, stops, rolling

**Profit-taking.**
- **Holding to expiry beat managing early on Spintwig's scorecard.** 16 underlyings; a 45-day Put opened daily at 15:46 ET; $1 a contract plus a slippage model; mostly 2007–2019; re-checked.
  - Holding to expiry had the better Sharpe in 66 of the 79 ticker × delta pairs with both figures.
  - Closing at 50% profit or at 21 days won 11 (SPY 5, IWM 4, AAPL 1, AMZN 1), and 2 tied.
  - MU managed: −1.29 to +0.07, against 0.17 to 0.26 held.
- **On the SPY Wheel, profit-taking cost CAGR and deepened drawdowns.** Taking profit at 50% cut CAGR at 4 of 5 deltas and deepened Max drawdown at 3 of 5. At 30 delta, Max drawdown was −69.0% against −43.1%; at 50 delta the account went negative.
- **Counterpoints, all index only:**
  - On SPY, managing softened the worst month by 54%, 47%, 42% and 33% at 2.5, 5, 10 and 16 delta.
  - tastylive Market Measures 2018 (SPY 16-delta Puts at about 45 days, 2005–2017; page summary only): managing at 25%, at 50% or at 21 days ended with similar P&L, all above holding.
  - Thetadesk: held to expiry made 0.29% of collateral per trade against 0.19% closed at 50%. Per year of capital, closing made 4.4% against 2.4% held, assuming the freed cash is reused at once. At 5 days the advantage is "real but small".
  - theoptionsbench: a 50% target or a 21-day exit left the worst month unchanged in 4 of 5 strategies.
- **Our case:** Marcelo dropped a take-profit test on 2026-10-20 as unlikely to give meaningful results ([IDEAS-TO-TRY.md](IDEAS-TO-TRY.md), D-01).

**Stop-losses on the option.**
- **Stops lowered Sharpe on SPY.** Spintwig, SPY short Puts at 45 days (2007-01 to 2019-07; 54 backtests; 170,500 trades):
  - Stops at 1× to 5× the credit lowered the Sharpe ratio in 27 of 30 variants; 2 tied, and 1 improved (5 delta at 5×: 0.63 against 0.60).
  - At 16 delta: no stop 0.76; 1× 0.59; 2× 0.68; 3× 0.72.
  - A 1× stop gave the lowest volatility.
- **Other results:**
  - [FlashAlpha](https://flashalpha.com/articles/spy-put-credit-spread-active-backtest-mm-fills-vrp-signal-drawdown-breaker) (vendor; its figures contradict themselves in places):
    - 45-delta, 30-day spreads: no stop 3.8% CAGR; 100% stop 3.5%; 200% stop −2.5%.
    - 10-delta, 7-day spreads without a stop went to −100%; with a 100% stop they made 66% CAGR, with a 30.1% Max drawdown.
  - Thetadesk: a 50% target plus a 2× stop improved the worst week from −25% to −9% of collateral. Return per year of capital fell from 4.4% to 2.3%.
  - ERN (about 3× leverage) adopted stops in 2022 and moved to stop-limit orders after bad flash-crash fills in October 2025. He reports no losing month since June 2022 (self-reported).
  - [San Jose Options](https://www.sjoptions.com/does-tastytrade-work/): SPX strangles 2005–16 with 2× stops still lost money at most position sizes.
- **Relevance:** stops pay where leverage creates a risk of ruin. We are cash-secured, and our share stop-loss failed (BACKTEST-FINDINGS.md, Round 5).

**Rolling.** See section 4: by put-call parity it equals a strike rule. The SEC alleged that "Karen the Supertrader" hid more than $50 million of losses by rolling them forward (section 11).

**After an assignment.** Spintwig noted this on its SPY Wheel at 45 days, without a table: "When a CSP expired ITM it was generally followed by an upward move that caused a loss on the covered call", and "when the covered call expired ITM it was generally followed by a decrease in IV".

## 8. Sizing and drawdown control

- **Volatility targeting thins the left tail.**
  - [Harvey et al., The Impact of Volatility Targeting](https://people.duke.edu/~charvey/Research/Published_Papers/P135_The_impact_of.pdf) (JPM 2018; 60+ assets, 1927–2017): it lowered the left tail, and the volatility of volatility, in every asset. Equity Sharpe rose from 0.40 to 0.48–0.51. Sharpe gains appeared only where falling prices raise volatility (equities, credit).
  - [Moreira & Muir](https://www.nber.org/papers/w22208) (JF 2017): taking less risk when volatility is high raised Sharpe ratios across equity factors and the currency carry trade, a utility gain of about 65%. Alphas stayed significant with weights capped at 1 or 1.5.
- **But it may not work in real time.** [Cederburg et al.](https://www.lehigh.edu/~xuy219/research/COWY.pdf) (JFE 2020; 103 strategies): versions run in real time generally earned lower Sharpe ratios than the unmanaged ones.
- **One option-selling test is too short to rely on.** [Wysocki](https://arxiv.org/html/2508.16598v1) (arXiv 2025; SPX 0–5-day put-writing sized by VIX rank) has only one out-of-sample year.
- **Theory on drawdown limits and bet size.**
  - [Grossman & Zhou](https://ideas.repec.org/a/bla/mathfi/v3y1993i3p241-276.html) (1993; theory): under a Max drawdown limit, the best exposure is proportional to the distance between the account and a floor tied to its running peak.
  - [MacLean, Thorp & Ziemba](https://www.stat.berkeley.edu/~aldous/157/Papers/Good_Bad_Kelly.pdf):
    - Half Kelly keeps 75% of the growth rate, and raises the chance of doubling before halving from 0.67 to 0.89. Twice Kelly gives zero growth.
    - Errors in the estimated mean cost about 20 times as much as errors in variance.
    - No Kelly analysis was found for single-stock Puts held to expiry.
- **Index option sellers did better when volatility was high, the opposite of volatility targeting.**
  - Spintwig, SPX 16-delta Puts at 45 days by VIX at entry (2007-01 to 2022-10; 7,880 trades). The VIX 15–20 bucket was worst on both total and risk-adjusted return:

    | VIX at entry | Premium kept | Win rate |
    |---|---|---|
    | below 15 | 33.4% | 94.1% |
    | 15–20 | 6.1% | 89.0% |
    | 20–25 | 36.7% | 91.2% |
    | 25 and above | 76.0% | 96.1% |

  - FlashAlpha (vendor; SPY put spreads at 22–45 days), realized P&L per spread by implied-volatility regime:

    | IV regime | P&L per spread |
    |---|---|
    | 30+ | +$0.54 |
    | 22–30 | +$0.16 |
    | 16–22 | +$0.05 |
    | 12–16 | −$0.10 |
    | below 12 | −$0.66 |

  - FlashAlpha's strongest entry predictor was a "falling VIX" flag, which it didn't define. Days in the top fifth of the volatility premium had lower win rates (66% against 74%).
  - tastytrade's rule of thumb: use 25% of buying power at a VIX of 10–15, rising to 50% above 40. No results are shown.
  - [IVolatility](https://www.ivolatility.com/news/3127) (SPY 2021–26): the 20-day forward return was +3.78% when implied volatility was 25–35, against +0.90% below 15. This was not significant once overlapping windows were removed (p = 0.243).
  - ERN: March 2020 was his best month. He also warns: "never, ever raise your leverage when things are going against you" ([part 4](https://earlyretirementnow.com/2020/06/10/passive-income-through-option-writing-part-4/)).
- **Our own test:** our Sortino lab found that volatility-managed exposure on the stock itself failed on 23 symbols (BACKTEST-FINDINGS.md, Round 3a).

## 9. Hedging: spreads, collars, protective Puts, tail hedges

**Put spreads (defined risk).**
- **A protective Put cut SPY's drawdown sharply, at a cost in CAGR.** [theoptionsbench, defined risk vs naked](https://theoptionsbench.com/defined-risk-vs-naked-backtest/) (SPY 30-delta Put with a 10-delta protective Put; real fills 2010–2023):
  - CAGR 2.65% against 3.75% for the plain Put; Max drawdown −7.8% against −28.5%; worst month −6.2% against −28.4%.
  - The protective Puts paid back 0.63 times their cost.
  - Lowering delta alone doesn't fix the tail: SPY 10-delta Puts made 1.4% CAGR, with a worst month of −25.2% against −29.6% at the money.
- **Other results:**
  - Spintwig, SPY Put spreads at 45 days held to expiry (re-checked): Sharpe 0.84 at 10/5 delta, and 0.79 at 16/5 and 16/2.5, against 0.73 and 0.76 for plain 10- and 16-delta Puts.
  - FlashAlpha (after costs): a 25/10-delta Put spread made −0.01% per trade with a Max drawdown of −6.2%, against +0.09% and −14.7% for the Cash-Secured Put.
  - [Cboe fact sheet](https://cdn.cboe.com/resources/indices/documents/benchmarks-fact-sheet.pdf), Max drawdown 2006–2019: the iron condor index (CNDR) −13.7%, PUT −32.7%, S&P −51.0%. [Black & Szado](https://s202.q4cdn.com/174824971/files/doc_news/2016/02/study-analyzes-performance-of-cboe-spx-options-selling-indexes-pdf1691637391968.pdf): CNDR had the lowest volatility, 7.23% against 10.16% for PUT (1986–2015).
  - [tastylive](https://www.tastylive.com/shows/market-measures/episodes/cost-of-buying-protection-short-puts-12-21-2016): on SPY, spreads cut the biggest losses but earned less.
  - Against: ERN found plain far out-of-the-money Puts beat spreads on SPX.
- **Caveats for us:**
  - A 1–7-day wing pays only if the stock is below it at that expiry. Our damage is the slow bleed after assignment, which such a wing never touches.
  - Single-stock wings have wide spreads, and Put skew makes them dear after a fall.
  - The engine doesn't buy options today.

**Collars, protective Puts and tail hedges.**
- **AQR on adding Puts.** [AQR, Understanding the Volatility Risk Premium](https://www.aqr.com/-/media/AQR/Documents/White-Papers/Understanding-the-Volatility-Risk-Premium.pdf) (1996–2016): monthly 5% out-of-the-money Puts cut the S&P's return from 5.1% to 1.8% and its Sharpe from 0.32 to 0.14, for a Max drawdown of −57% instead of −62%. The same paper notes that drawdowns of volatility-premium strategies coincided with equity crashes, which is why spreading a book across names helps less than it seems.
- **Collars cost return.** [Israelov & Klein](https://www.cxoadvisory.com/equity-options/equity-index-collar-performance) (1986–2014): Cboe's collar index made a 3.2% excess return against 7.3%, with a Sharpe of 0.30 against 0.47.
- **Cboe's Put-protection index did worse than put-writing.** PPUT (the S&P 500 plus 5% out-of-the-money Puts) made 6.64% against 9.54% for PUT, with a deeper Max drawdown (−38.9% against −32.7%) (Bondarenko).
- **Man Group** ([Hedge Survival](https://www.man.com/insights/hedge-survival-making-it-to-the-next-crisis), to March 2019):
  - Monthly 95% Puts made 4.51% a year (Max drawdown −44.25%), and yearly 90% Puts 5.97% (−35.9%), against 8.00% for the S&P (−55.1%).
  - The same collar started one month apart returned −6.84% and −4.33% a year.
- **Collars on ETFs.** FlashAlpha (ETFs 2020–2025): a collar made +0.43% per trade (Max drawdown −17.8%), against +0.76% (−24.1%) for a Covered Call. Hemler & Miller: protective Puts and collars did worse than holding the stock, risk-adjusted.
- **Tail hedges.**
  - [AQR, Tail Risk Hedging: Contrasting Put and Trend Strategies](https://images.aqr.com/-/media/AQR/Documents/Insights/White-Papers/AQR-Tail-Risk-Hedging-Contrasting-Put-and-Trend-Strategies.pdf) (2020):
    - Monthly 5% out-of-the-money Puts, scaled to 10% volatility, returned −6.4% a year with a −92% Max drawdown.
    - The tail-hedge fund index lost about 2% a year since 2008, and about 8% a year in the 2010s.
    - Timing hedges by calm markets or rising volatility didn't help.
  - [Universa's own letter](https://www.bloomberg.com/news/articles/2020-04-08/taleb-advised-universa-tail-risk-fund-returned-3-600-in-march), disputed by critics: a 3.3% hedge allocation compounded at 11.5% a year against 7.9% since 2008.
- **Trend instead of Puts.**
  - AQR 2020: multi-asset trend returned 8.7% a year in excess return, with a Sharpe of 0.84 and a Max drawdown of −35%. It was profitable in 6 of 8 slow and 9 of 10 fast equity tail events.
  - Of the S&P's 10 worst months, none was the first month of its drawdown, and trend made money in 9 of the 10.
  - [Newfound](https://blog.thinknewfound.com/2020/05/straddles-and-trend-following/): trend beat straddles for nearly every lookback until March 2020.
  - This needs futures and margin, which a cash-secured design doesn't have.

## 10. Warning signals: which stocks, and when

**Option-implied signals.**
- **Expensive Calls against Puts.** [Cremers & Weinbaum](https://ideas.repec.org/a/cup/jfinqa/v45y2010i02p335-367_00.html) (JFQA 2010; abstract): stocks whose Calls are expensive against same-strike Puts beat stocks with expensive Puts by about 0.5% a week (1996–2005). The effect shrank over time.
  - A [Copenhagen Business School thesis](https://research-api.cbs.dk/ws/portalfiles/portal/60755923/306868_Trading_on_deviations_from_put_call_parity_and_mean_reversion.pdf) on 2011–2015 found 0.19% at one week and 0.73% at four.
- **Rising Put IV.** [An, Ang, Bali & Cakici](https://www.nber.org/papers/w19590) (JF 2014; abstract): large one-month rises in Call implied volatility were followed by higher returns, and rises in Put implied volatility by lower ones. The spread between top and bottom deciles was about 1% a month, lasting up to 6 months.
- **The volatility smirk.** [Xing, Zhang & Zhao](https://ideas.repec.org/a/cup/jfinqa/v45y2010i03p641-662_00.html) (JFQA 2010): stocks with the steepest smirks underperformed by 10.9% a year (1996–2005).
- **Implied skewness.** Conrad, Dittmar & Ghysels (JF 2013; abstract): stocks with more positively skewed implied distributions earn lower returns later. Some papers find the opposite sign (Rehman and Vilkov; Bali et al.).
- **One recent study covers 2015–2026.** [Li & Wang](https://arxiv.org/abs/2608.26115) (arXiv 2026; not peer-reviewed; the authors couldn't be verified; 10,026 underlyings):
  - The Call–Put IV spread was significant in every period (\|t\| > 4).
  - Implied skewness was the most robust predictor (t −13 at 21 days).
  - The smirk decayed from t −5.5 (2015–19) to −1.5 (2023–26), which matches our own finding that a steep Put skew pointed the wrong way.
  - An inverted IV term structure predicted lower stock returns (t 3–5).
  - The public put-call ratio was weak.
  - Option signals predicted 5-day crashes poorly in 2020–22 (AUC 0.56, where 0.5 is a coin flip).
- **Option volume against stock volume.** [Johnson & So](https://ideas.repec.org/a/eee/jfinec/v106y2012i2p262-286.html) (JFE 2012; abstract): stocks in the lowest decile of option-to-stock volume beat the highest by 0.34% a week, more so when shorting is costly.
  - Pan & Poteshman's put-call signal (RFS 2006) needs data on who started each trade, which isn't public.
- **The IV term structure.** [Vasquez](https://www.cxoadvisory.com/volatility-effects/exploiting-the-implied-volatility-term-structure/) (JFQA 2017; summary; about 260 stocks a month, 1996–2007): straddles on stocks whose short-dated IV is above long-dated IV lost 12.2% a month for buyers.
  - Its sign conflicts with Johnson's index result (below).
  - For an unhedged seller the two effects may offset: rich options, but a weaker stock.
- **Realized against implied volatility.**
  - [Goyal & Saretto](https://docs.lib.purdue.edu/ciberwp/55) (JFE 2009; abstract): sorting stocks on realized minus implied volatility gives significant long-short option returns.
  - [Ahn](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7095738) (SSRN preprint, 2014–2025; abstract): selling Puts on the highest implied-to-realized ratio and buying on the lowest earned a Sharpe of 2.24 before costs and 1.25 after. This works across tickers, so it fits a shared book rather than per-ticker pots.
- **Option momentum.** [Jones, Khorram & Mo; Heston et al.](https://www.cxoadvisory.com/calendar-effects/stock-option-momentum-and-seasonality/) (1996–2019, before costs):
  - Straddle returns persist over 6–36-month lookbacks, reverse at one month, and repeat at 3- and 12-month lags.
  - The average straddle lost 5.6% a month for buyers.
  - The strategies' Max drawdowns were −40% to −69%.

**Run-ups, crashes and distress.**
- **Run-ups predict crashes, not lower average returns.** [Greenwood, Shleifer & You, Bubbles for Fama](https://www.nber.org/system/files/working_papers/w23191/w23191.pdf) (JFE 2019; full text; US industries 1928–2014; only about 40 US episodes):
  - After a 100% two-year run-up, 53% fell 40% or more within two years, against 14% unconditionally. After a 150% run-up, 80% did.
  - Average future returns were not lower.
  - Even in run-ups that crashed, the peak came about 6 months later, after a further 30% gain on average.
  - Run-ups that crashed showed rising volatility, share issuance, younger firms and acceleration (the two-year return minus the first year's). Exiting on volatility, firm age or acceleration beat holding by at least 10 points over two years.
  - This fits our entry filter costing as much in missed rallies as it saved.
- **Crash predictors**
  - Chen, Hong & Stein (JFE 2001; abstract): crashes concentrate in stocks with rising trading volume over 6 months and high 36-month returns.
  - Jang & Kang (JFE 2019; abstract): stocks with a high estimated crash probability earn abnormally low returns.
- **After a fall**
  - Atilgan, Bali, Demirtas & Gunaydin (JFE 2020; abstract): stocks with large recent extreme losses keep underperforming, more so in retail-held names.
  - Da, Liu & Schaumburg (Management Science 2014; abstract): short-term reversals come from moves without news, while news-driven moves don't reverse.
- **Crowds and disagreement**
  - [Barber, Huang, Odean & Schwarz](https://gsm.ucdavis.edu/news/what-effect-brokerage-robinhood-having-stock-market) (JF 2022): stocks Robinhood users bought most fell 4.7% against the market over the next 20 days.
  - Diether, Malloy & Scherbina (JF 2002): stocks with high analyst disagreement underperform; a follow-up paper cites a 9.48% a year spread between quintiles.
  - We have no short-interest or analyst data.

**Market-wide signals.**
- **The VIX term structure.** [Johnson](https://ideas.repec.org/a/cup/jfinqa/v52y2017i06p2461-2490_00.html) (JFQA 2017; [summary](https://www.cxoadvisory.com/volatility-effects/vix-term-structure-slope-and-variance-asset-future-returns/)): the slope predicts returns on variance swaps, VIX futures and S&P straddles. A low or inverted slope predicts high returns to long volatility, which is bad for sellers. Next-day spreads between quintiles ran 0.29% to 1.81% across 18 assets (1996–2013).
- **The VIX premium.** [Cheng, The VIX Premium](https://ideas.repec.org/a/oup/rfinst/v32y2019i1p180-227..html) (RFS 2019): the VIX premium falls or stays flat when risk rises, and falling premiums predict higher risk.
- **The implied-minus-realized variance gap.** [Bollerslev, Tauchen & Zhou](https://ideas.repec.org/a/oup/rfinst/v22y2009i11p4463-4492.html) (RFS 2009; abstract): a high gap predicts higher stock-market returns, most strongly at a quarterly horizon.
- **A high VIX after strong years.** [Neuberger Berman](https://www.nb.com/de/at/insights/vixology): when 12-month equity returns were strong, an above-average VIX roughly doubled the odds of PUT beating the S&P, to 35.8%.
- **Against timing:** AQR found that neither calm markets nor rising volatility helped time hedges.
- **Not found:** any backtest of put-writing gated on the VIX term structure, or measured results for credit-spread or breadth filters.

**Time of day and week.**
- **Option prices are too high at the close.** [Muravyev & Ni](https://www.cxoadvisory.com/equity-options/intraday-versus-overnight-option-returns/) (JFE 2020; 2004–2013): delta-hedged single-stock options returned −0.4% overnight against +0.1% intraday per day (S&P options −1.0% against +0.3%). In their words, "option prices are too high at the close and too low at the open".
- **Weekends.** [Jones & Shemesh](https://ideas.repec.org/a/bla/jfinan/v73y2018i2p861-900.html) (JF 2018): option returns are significantly lower over non-trading periods, mostly weekends. The working paper found −0.62% from Friday to Monday for stock options (1996–2007), and little effect in S&P options.
- **Expiry week.** Stivers & Sun (2013): S&P 100 stocks gained 0.45% a week in expiry week, against 0.12% in other weeks (1996–2008). A test on the PUT index (1986–2017) found the second week after expiry best. This has little relevance to 1–7-day options.
- **Selling after down days.** tastylive (SPY; search summary only): waiting for more consecutive down days raised the win rate and average P&L. StockWirex (not opened): strangles opened after down days of 3% or more doubled average P&L, with larger worst-case losses.
- **Practitioners sell late.** Spintwig's backtests all enter at 15:46 ET, and ERN sells in the last hour.

**Earnings.**
- **Straddles gain into announcements and lose after.** [Gao, Xing & Zhang](https://www.pbcsf.tsinghua.edu.cn/__local/B/7B/EF/9C90E5DE82928B64858EFBA685C_E7B3C45C_4183B.pdf?e=.pdf) (JFQA 2018; full 2017 text; 1996–2013):
  - Delta-neutral at-the-money straddles lose 2.12% a week on average.
  - From 3 days before an announcement to the announcement, they earn +3.34%, most on small, volatile firms with fat tails and little analyst coverage.
  - From the announcement to the next day they return −0.33% (not significant) to −1.37%.
- **Actual moves fell short of implied.** [ORATS](https://orats.com/blog/the-wildest-earnings-week-on-record) (practitioner; 3 years; about 338 firms a week): the actual earnings move averaged about 85% of the implied move.
- **Earnings risk is priced.** [Dubinsky et al.](https://ideas.repec.org/a/oup/rfinst/v32y2019i2p646-687..html) (RFS 2019): earnings risk is large, varies over time, and is priced.
- **Overall:** sellers holding to expiry have little edge either way, which fits our earnings-skip result.

**Trend filters.**
- **They trade return for drawdown.** [The Long Trend](https://thelongtrend.substack.com/p/i-tried-to-debunk-the-200-day-moving) (practitioner, 2026; 193 tickers, 2011–2026; cash while below the 200-day average):
  - Max drawdown was shallower on 82% of tickers (average −62% to −50%), but risk-adjusted return was better on only 25%.
  - On SPY the filter cost 3.7 points of CAGR and removed 14 points of drawdown.
  - The best average length was unstable between the two halves of history (correlation 0.03).
- **On put spreads.** [Option Alpha, trend trading podcast](https://optionalpha.com/podcast/trend-trading) (SPY, GLD and TLT 45-day put spreads; described in words only): the filter cut drawdowns, avoided a large SPY drawdown and helped TLT, but hurt GLD.
- **Not found:** a moving-average test on the PUT or BXM index.

## 11. Blow-ups, and the rules people adopted

- **LJM, February 2018.**
  - The fund lost more than 80% within days in early February 2018: its share price fell to $1.94, and about $600 million was lost. Sources differ on the starting price and the assets ($768 million or $812 million). [SLCG's stress test](https://www.slcg.com/resources/blog/685) of its October 2017 book: −5% on the index cost $30 million, +20 volatility points $274 million, and both together $378 million, "approximately what happened".
  - [SteadyOptions](https://steadyoptions.com/articles/the-spectacular-fall-of-ljm-preservation-and-growth-r336/) estimates an unlevered version would have lost 10–15% that day.
  - LJM's put spreads didn't stop the loss.
- **OptionSellers.com, November 2018** ([ERN](https://earlyretirementnow.com/2018/12/18/the-optionsellers-debacle/), [CNBC](https://www.cnbc.com/2018/11/21/a-risky-natural-gas-bet-gone-awry-leads-to-weepy-youtube-confessional.html)):
  - About 290 managed accounts held naked short natural-gas Calls. One account ERN examined held 218 short Calls on about $1 million, "20 to 40 times" a sensible size.
  - Gas rose 18% on 14 November, and clients ended up owing the clearing firm.
  - Rules adopted afterwards: size by full value, not margin; expect margin requirements to double or triple.
- **XIV, 5 February 2018.** Its NAV fell from $115.55 to $4.22 (−96.3%; other sources give 80–93%) on the VIX's record 115.6% one-day rise, and the note was terminated ([etf.com](https://www.etf.com/sections/news/vix-etns-closure-accelerated)).
- **Malachite, March 2020.** About $600 million in short equity volatility; margin calls; wound down ([Institutional Investor](https://www.institutionalinvestor.com/index%2ephp/article/2bswy6cn47m9ct8vbn4zk/corner-office/a-hedge-funds-fatal-bet-and-the-consulting-firm-tied-up-in-the-mess)).
- **"Karen the Supertrader".** The [SEC alleged in 2016](https://www.sec.gov/news/press-release/2016-98) that fees on realized gains only let her firm avoid realizing more than $50 million of losses, by rolling them forward.
- **Niederhoffer.** He sold out-of-the-money S&P Puts on margin and was force-closed by his broker in 1997, and again in 2007.
- **Retail wheel traders, 2022.** Names cited: RIDE, PTON, SPCE, NKLA, BBBY. A hypothetical "Theta Gang" model on [Collective2](https://collective2.com/details/137756297) had a −46.4% Max drawdown in June 2022.
- **What applies to us.**
  - Every blow-up combined leverage, a loss limit that wasn't enforced, and mark-to-market losses in a volatility spike. We are cash-secured and unlevered, so the margin-call failures don't apply.
  - What remains is concentration in stocks that can fall 90%, which is exactly our damage.
  - ERN's rule applies: never sell what you couldn't hold to expiry.

## 12. Our own results against the research

| Our test | Our result | What the research says |
|---|---|---|
| Skip expiries that span earnings | Changed few trades; no gain | Straddles gain before announcements and lose after; sellers holding to expiry have little edge either way (Gao, Xing & Zhang). Consistent. A per-ticker rule is the remaining variant. |
| Sell only when IV beats our own forecast (volatility edge filter) | Failed; helps only by trading less | The academic edge is relative across stocks and delta-hedged, and most of it goes on costs (Saretto: 16.1% → 5.5%). Consistent. |
| Edge Yield ranking, Signals model fields as filters | Failed; the model's fields point the wrong way on falls | The model values richness symmetrically around today's price; the research says richness and stock drift come together on single stocks. Consistent. |
| Share stop-loss | Failed; swings tickers both ways | Stop rules always lower expected return when prices move randomly, and help only with momentum (Kaminski & Lo). Consistent; trend-aware alternatives are I-01 and I-02 in IDEAS-TO-TRY.md. |
| A deeper ladder | Failed | Averaging down is an unpaid reversal bet (Israelov & Nielsen). Consistent; a shallower ladder (I-06) is untested. |
| Entry filters: stretched stock, IV Rank 70–90 | Shallower drawdowns, missed rallies, net zero | Run-ups predict crashes but not lower average returns, and the peak comes about 6 months later after a further 30% gain (Greenwood, Shleifer & You). Consistent; the research suggests such signals limit the ladder, not the entry. |
| Weak market (SPY below its 200-day average) as a warning | Points the wrong way | Index option sellers did better after high-VIX entries (Spintwig VIX buckets). Consistent. |
| Steep Put skew as a warning | Points the wrong way | The smirk faded to insignificant in 2023–2026 (Li & Wang). Consistent. |
| Stock-only timing: momentum, volatility management, SPY trend (Sortino lab) | Failed the hold-out; missed V-shaped rebounds | Trend rules trade return for drawdown (The Long Trend: risk-adjusted return better on 25% of tickers). Consistent. |

## 13. Gaps and credibility

- **Sources not reached.** The search cap stopped every thread early. Not reached:
  - practitioner sources: tastytrade's own result tables (the episode pages now redirect), Option Alpha beyond one podcast, projectfinance, Euan Sinclair, Benn Eifert, Moontower and Steady Options;
  - Reddit (blocked for the research tools), YouTube transcripts and Seeking Alpha articles;
  - topics: a moving-average test on PUT or BXM; credit-spread and breadth filters; how many names it takes to diversify a book of short Puts; distress risk in option selling; post-earnings drift; early exercise.
- **Sites that refused requests:** spintwig.com, mdpi.com and ssrn.com returned 403. Spintwig's figures come from archived copies and the scorecard table.
- **Credibility flags:**
  - Li & Wang (2026) is a preprint whose authors couldn't be verified.
  - FlashAlpha is a data vendor whose articles contradict themselves in places.
  - Thetadesk and FlashAlpha's matrix use modelled prices.
  - Cboe paid for Bondarenko's studies.
  - Many academic items were read as abstracts or summaries only; each is flagged above.
- **How well it fits us.** Most evidence is index options or 1986–2019 samples. The one study covering 2020–2026 found option-implied crash signals weak in 2020–22.
- **A second round** could fill these gaps. It is unlikely to change the top of the shortlist, which five of the six threads reached independently.

## 14. Main sources

Academic and industry research:
- [Israelov & Nielsen, Covered Call Strategies: One Fact and Eight Myths (FAJ 2014)](https://www.aqr.com/-/media/AQR/Documents/Insights/Journal-Article/FAJ-Covered-Call-Strategies-One-Fact-and-Eight-Myths.pdf)
- [Israelov & Nielsen, Covered Calls Uncovered (FAJ 2015)](https://www.aqr.com/Insights/Research/Journal-Article/Covered-Calls-Uncovered)
- [Carr & Wu, Variance Risk Premiums (RFS 2009)](https://engineering.nyu.edu/sites/default/files/2019-01/CarrReviewofFinStudiesMarch2009-a.pdf)
- [Driessen, Maenhout & Vilkov, The Price of Correlation Risk (JF 2009)](https://ideas.repec.org/a/bla/jfinan/v64y2009i3p1377-1406.html)
- [Bondarenko, Historical Performance of Put-Writing Strategies (Cboe 2019)](https://cdn.cboe.com/resources/education/research_publications/PutWriteCBOE19_v14_by_Prof_Oleg_Bondarenko_as_of_June_14.pdf)
- [Cboe, weekly and monthly PutWrite indexes (2016)](https://ir.cboe.com/news/news-details/2016/New-Study-On-Weekly-Monthly-SP-500-PutWrite-Indexes-Released-01-27-2016/default.aspx)
- [Cao & Han, idiosyncratic volatility and option returns (JFE 2013)](https://www.cxoadvisory.com/volatility-effects/extracting-a-volatility-premium-with-equity-options)
- [Saretto, the cross-section of option returns (2005 working paper)](https://www.cis.upenn.edu/~mkearns/finread/CrossOptions.pdf)
- [Heston, Jones, Khorram, Li & Mo, Option Momentum (JF 2023)](https://www.acem.sjtu.edu.cn/sffs/2021w/pdfs/3.pdf)
- [Cremers & Weinbaum, Deviations from Put-Call Parity (JFQA 2010)](https://ideas.repec.org/a/cup/jfinqa/v45y2010i02p335-367_00.html)
- [An, Ang, Bali & Cakici, The Joint Cross Section of Stocks and Options (JF 2014)](https://www.nber.org/papers/w19590)
- [Xing, Zhang & Zhao, What Does the Individual Option Volatility Smirk Tell Us (JFQA 2010)](https://ideas.repec.org/a/cup/jfinqa/v45y2010i03p641-662_00.html)
- [Li & Wang, option-implied predictors of stock returns, 2015–2026 (arXiv 2026, not peer-reviewed)](https://arxiv.org/abs/2608.26115)
- [Greenwood, Shleifer & You, Bubbles for Fama (JFE 2019)](https://www.nber.org/system/files/working_papers/w23191/w23191.pdf)
- [Jegadeesh & Titman, Returns to Buying Winners and Selling Losers (JF 1993)](https://ideas.repec.org/a/bla/jfinan/v48y1993i1p65-91.html)
- [Moskowitz, Ooi & Pedersen, Time Series Momentum (JFE 2012)](https://ideas.repec.org/a/eee/jfinec/v104y2012i2p228-250.html)
- [Moreira & Muir, Volatility-Managed Portfolios (JF 2017)](https://www.nber.org/papers/w22208)
- [Harvey et al., The Impact of Volatility Targeting (JPM 2018)](https://people.duke.edu/~charvey/Research/Published_Papers/P135_The_impact_of.pdf)
- [Cederburg et al., On the Performance of Volatility-Managed Portfolios (JFE 2020)](https://www.lehigh.edu/~xuy219/research/COWY.pdf)
- [Grossman & Zhou, Optimal Investment Strategies for Controlling Drawdowns (1993)](https://ideas.repec.org/a/bla/mathfi/v3y1993i3p241-276.html)
- [MacLean, Thorp & Ziemba, Good and Bad Properties of the Kelly Criterion](https://www.stat.berkeley.edu/~aldous/157/Papers/Good_Bad_Kelly.pdf)
- [Kaminski & Lo, When Do Stop-Loss Rules Stop Losses? (2014)](https://dspace.mit.edu/handle/1721.1/114876)
- [Odean, Are Investors Reluctant to Realize Their Losses? (JF 1998)](https://rpc.cfainstitute.org/-/media/documents/article/cfa-digest/1999/dig-v29-n2-469-pdf.pdf)
- [Muravyev & Ni, Why Do Option Returns Change Sign from Day to Night? (JFE 2020)](https://www.cxoadvisory.com/equity-options/intraday-versus-overnight-option-returns/)
- [Jones & Shemesh, Option Mispricing around Nontrading Periods (JF 2018)](https://ideas.repec.org/a/bla/jfinan/v73y2018i2p861-900.html)
- [Hemler & Miller, performance of options strategies (OIC 2015)](https://prd-web.optionseducation.org/getmedia/c3b5a9b7-2524-4c56-9246-367d03e81e85/perf-options-strategies.pdf)
- [Gao, Xing & Zhang, Anticipating Uncertainty: Straddles around Earnings (JFQA 2018)](https://www.pbcsf.tsinghua.edu.cn/__local/B/7B/EF/9C90E5DE82928B64858EFBA685C_E7B3C45C_4183B.pdf?e=.pdf)
- [AQR, Tail Risk Hedging: Contrasting Put and Trend Strategies (2020)](https://images.aqr.com/-/media/AQR/Documents/Insights/White-Papers/AQR-Tail-Risk-Hedging-Contrasting-Put-and-Trend-Strategies.pdf)
- [J.P. Morgan, The Agony & the Ecstasy (2014)](https://www.chase.com/content/dam/privatebanking/en/mobile/documents/eotm/eotm_2014_09_02_agonyescstasy.pdf)

Practitioner backtests and commentary:
- [Spintwig, Options Scorecard and short-option backtests (archived copies)](https://spintwig.com/options-scorecard/)
- [theoptionsbench, wheel strategy backtest](https://theoptionsbench.com/wheel-strategy-backtest/) and [defined risk vs naked](https://theoptionsbench.com/defined-risk-vs-naked-backtest/)
- [Early Retirement Now, The Wheel Strategy Doesn't Work (2024)](https://earlyretirementnow.com/2024/09/17/the-wheel-strategy-doesnt-work-options-series-part-12/)
- [The Long Trend, 200-day moving average test on 193 tickers](https://thelongtrend.substack.com/p/i-tried-to-debunk-the-200-day-moving)
- [Option Alpha, trend trading podcast](https://optionalpha.com/podcast/trend-trading)
- [ORATS, covered combo backtest](https://orats.com/blog/testing-the-covered-combo-options-strategy)
- [Thetadesk, closing winners at 50%](https://thetadesk.substack.com/p/should-you-close-winners-at-50-i)
- [Kapadia & Szado, Russell 2000 Covered Calls (summary)](https://www.cxoadvisory.com/equity-options/russell-2000-index-buy-write-strategy-performance)

Funds and cautionary tales:
- [totalrealreturns.com comparisons (e.g. TSLY vs TSLA)](https://totalrealreturns.com/n/TSLY,TSLA)
- [J.P. Morgan, JEPI fact sheet](https://am.jpmorgan.com/content/dam/jpm-am-aem/americas/us/en/literature/fact-sheet/etfs/FS-JEPI.pdf)
- [SLCG, LJM stress test](https://www.slcg.com/resources/blog/685)
- [Early Retirement Now, the OptionSellers.com debacle](https://earlyretirementnow.com/2018/12/18/the-optionsellers-debacle/)
- [SEC, "Karen the Supertrader" (2016)](https://www.sec.gov/news/press-release/2016-98)
