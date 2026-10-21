// `/x/flashcards` (ROADMAP item 34, DESIGN §6.34): the decks with what is due today, a review
// session (`?view=review&deck=…` or `&note=…`), statistics (`?view=stats`) and settings
// (`?view=settings`). One page, so the ribbon and the drawer have one entry.
import { BarChart3, Layers, Play, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import { useCallback, useMemo, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { errorMessage } from '../../api/client';
import { queryClient } from '../../api/queryClient';
import { usePageTitle } from '../../components/pages/usePageTitle';
import { navigateTo } from '../../features/navigation';
import { countItems, deckTree, doneToday, limited, studyDay, type Counts, type DeckNode } from '../deck';
import { flashcardKeys } from '../store';
import { useFlashcards, useNow, type FlashcardData } from '../useFlashcards';
import { FLASHCARDS_ROUTE, flashcardsUrl, type Scope } from '../routes';
import { ReviewScreen } from './ReviewScreen';
import { SettingsView } from './SettingsView';
import { StatsView } from './StatsView';
import '../flashcards.css';

function CountChips({ counts, label }: { counts: Counts; label?: string }) {
  return (
    <span className="fc-counts" aria-label={`${label ? label + ': ' : ''}${counts.new} new, ${counts.learning} learning, ${counts.review} to review`}>
      <span className={`fc-count is-new${counts.new ? '' : ' is-zero'}`}>{counts.new}</span>
      <span className={`fc-count is-learning${counts.learning ? '' : ' is-zero'}`}>{counts.learning}</span>
      <span className={`fc-count is-review${counts.review ? '' : ' is-zero'}`}>{counts.review}</span>
    </span>
  );
}

function deckName(node: DeckNode): string {
  return node.name === '' ? 'Vault root' : node.label;
}

function DeckRows({ nodes, limit }: { nodes: DeckNode[]; limit: (c: Counts) => Counts }): ReactNode {
  return nodes.map((node) => {
    const counts = limit(node.counts);
    const due = counts.new + counts.learning + counts.review;
    return (
      <li key={node.name.toLowerCase()} className="fc-deck">
        <button
          type="button"
          className={`fc-deck-row${due ? '' : ' is-done'}`}
          style={{ paddingLeft: 12 + node.depth * 18 }}
          onClick={() => navigateTo(flashcardsUrl('review', { deck: node.name }))}
          aria-label={`Study ${deckName(node)}: ${counts.new} new, ${counts.learning} learning, ${counts.review} to review, ${node.counts.total} cards`}
        >
          <span className="fc-deck-name">
            <span className="fc-deck-label">{deckName(node)}</span>
            <span className="fc-deck-total">{node.counts.total} {node.counts.total === 1 ? 'card' : 'cards'}</span>
          </span>
          <CountChips counts={counts} />
        </button>
        {node.children.length > 0 && (
          <ul className="fc-decks">
            <DeckRows nodes={node.children} limit={limit} />
          </ul>
        )}
      </li>
    );
  });
}

function Empty({ config }: { config: NonNullable<FlashcardData['config']> }) {
  const tag = '#' + (config.tags[0] ?? 'flashcards');
  return (
    <div className="fc-empty">
      <Layers size={32} aria-hidden className="fc-empty-icon" />
      <p className="fc-empty-title">No flashcards yet</p>
      <p className="muted">
        {config.foldersAsDecks ? 'Write cards in any note; its folder is the deck.' : <>Tag a note <code>{tag}</code> (or <code>{tag}/spanish</code> for a deck) and write cards in it:</>}
      </p>
      <pre className="fc-empty-example">
        {`${config.foldersAsDecks ? '' : tag + '\n\n'}Capital of France::Paris
Big cat:::Lion            (both ways)

Multi-line question
?
Multi-line answer

Water boils at ==100 °C== at sea level.`}
      </pre>
      <p className="muted">This is the syntax of Obsidian’s Spaced Repetition plugin, so the notes work there too.</p>
    </div>
  );
}

function DeckList({ data, now }: { data: FlashcardData; now: number }) {
  const config = data.config!;
  const day = studyDay(now, config);
  const done = useMemo(() => doneToday(data.records, day.start), [data.records, day.start]);
  const tree = useMemo(() => deckTree(data.items, now, day.end), [data.items, now, day.end]);
  const all = limited(countItems(data.items, now, day.end), config, done);
  const limit = useCallback((c: Counts) => limited(c, config, done), [config, done]);
  const dueNow = all.new + all.learning + all.review;
  return (
    <>
      <section className="fc-today" aria-label="Today">
        <div className="fc-today-text">
          <div className="fc-today-number">{dueNow}</div>
          <div className="fc-today-label">{dueNow === 1 ? 'card to study today' : 'cards to study today'}</div>
          <CountChips counts={all} label="Today" />
          {done.answers > 0 && <div className="muted fc-today-done">{done.answers} answered today</div>}
        </div>
        <button type="button" className="button button-primary fc-study-all" disabled={dueNow === 0} onClick={() => navigateTo(flashcardsUrl('review'))}>
          <Play size={18} aria-hidden /> Study now
        </button>
      </section>
      {data.items.length === 0 ? (
        <Empty config={config} />
      ) : (
        <>
          <div className="fc-deck-head" aria-hidden>
            <span>Deck</span>
            <span className="fc-counts">
              <span className="fc-count is-new">New</span>
              <span className="fc-count is-learning">Learn</span>
              <span className="fc-count is-review">Due</span>
            </span>
          </div>
          <ul className="fc-decks fc-decks-root">
            <DeckRows nodes={tree} limit={limit} />
          </ul>
          <p className="muted fc-footnote">
            {data.items.length} cards in {data.notes} {data.notes === 1 ? 'note' : 'notes'}. Daily limits: {config.newPerDay} new, {config.reviewsPerDay} reviews.
            {data.pending > 0 && ` ${data.pending} ${data.pending === 1 ? 'answer is' : 'answers are'} waiting to be sent.`}
          </p>
        </>
      )}
    </>
  );
}

export default function FlashcardsPage() {
  usePageTitle('Flashcards');
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  const deck = params.get('deck');
  const note = params.get('note');
  const data = useFlashcards();
  const now = useNow(30_000);
  const scope = useMemo<Scope>(() => ({ deck, note }), [deck, note]);
  const exit = useCallback(() => navigateTo(FLASHCARDS_ROUTE), []);

  if (data.loading) return <div className="view-loading" aria-busy="true" />;
  if (data.error || !data.config || !data.scheduler) {
    return (
      <div className="page">
        <h1 className="page-title">Flashcards</h1>
        <p role="alert">Could not load the flashcards: {errorMessage(data.error)}</p>
        <button type="button" className="button" onClick={() => void queryClient.invalidateQueries({ queryKey: flashcardKeys.all })}>
          <RefreshCw size={16} aria-hidden /> Try again
        </button>
      </div>
    );
  }
  if (view === 'review') return <ReviewScreen key={location.key} data={data} scope={scope} onExit={exit} />;

  const header = (title: string, actions?: ReactNode) => (
    <header className="page-header">
      <h1 className="page-title">{title}</h1>
      {actions && <div className="fc-header-actions">{actions}</div>}
    </header>
  );
  if (view === 'stats') {
    return (
      <div className="page status-page fc-page">
        {header('Statistics', (
          <button type="button" className="button" onClick={exit}>
            <Layers size={16} aria-hidden /> Decks
          </button>
        ))}
        <StatsView data={data} now={now} />
      </div>
    );
  }
  if (view === 'settings') {
    return (
      <div className="page status-page fc-page">
        {header('Flashcard settings')}
        <SettingsView config={data.config} onDone={exit} />
      </div>
    );
  }
  return (
    <div className="page fc-page">
      {header('Flashcards', (
        <>
          <button type="button" className="icon-button" aria-label="Statistics" title="Statistics" onClick={() => navigateTo(flashcardsUrl('stats'))}>
            <BarChart3 size={18} aria-hidden />
          </button>
          <button type="button" className="icon-button" aria-label="Flashcard settings" title="Settings" onClick={() => navigateTo(flashcardsUrl('settings'))}>
            <SettingsIcon size={18} aria-hidden />
          </button>
        </>
      ))}
      <DeckList data={data} now={now} />
    </div>
  );
}
