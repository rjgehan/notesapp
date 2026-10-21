import { describe, expect, it } from 'vitest';
import { cardId, normalizeCardText, similarity } from './ids';
import { clozeBlank, maskLine, parseCards, type ParsedCard } from './parse';

const opts = { tags: ['flashcards'], foldersAsDecks: false };
const parse = (text: string, path = 'Cards/Note.md', o = opts) => parseCards(path, text, o);
const sides = (cards: ParsedCard[]) => cards.map((c) => [c.kind, c.front, c.back]);

describe('single-line cards', () => {
  it('reads Q::A and Q:::A (two cards), without list markers and SR comments', () => {
    const cards = parse('#flashcards\nCapital of France::Paris\n- [ ] Big cat:::Lion <!--SR:!2021-08-20,13,290-->\n');
    expect(sides(cards)).toEqual([
      ['basic', 'Capital of France', 'Paris'],
      ['basic', 'Big cat', 'Lion'],
      ['reverse', 'Lion', 'Big cat'],
    ]);
    expect(cards[0].line).toBe(1);
    expect(cards[1].sibling).toBe(cards[2].sibling);
    expect(cards[0].decks).toEqual(['flashcards']);
  });

  it('ignores :: in inline code, wikilinks, comments, code blocks and empty sides', () => {
    const text = [
      '#flashcards',
      'Use `std::vector` for lists',
      'See [[Note::x]] here',
      'Hidden %%a::b%% text',
      '```cpp',
      'std::string s;',
      '```',
      '::answer only',
      'question only::',
    ].join('\n');
    expect(parse(text)).toEqual([]);
  });

  it('keeps the id when only spacing changes, and changes it with the question', () => {
    const a = parse('#flashcards\nWhat  is 2+2?::4\n')[0];
    const b = parse('#flashcards\n  What is 2+2? :: four\n')[0];
    const c = parse('#flashcards\nWhat is 3+3?::6\n')[0];
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
    expect(a.id).toBe(cardId('qa', 'What is 2+2?'));
    expect(a.id).toMatch(/^c[0-9a-z]+$/);
  });
});

describe('multi-line cards', () => {
  it('reads ? and ?? paragraphs, ending at a blank line', () => {
    const text = '#flashcards\n\nLine one\nline two\n?\nAnswer one\nanswer two\n\nFront\n??\nBack\n\nNot a card\n';
    const cards = parse(text);
    expect(sides(cards)).toEqual([
      ['basic', 'Line one\nline two', 'Answer one\nanswer two'],
      ['basic', 'Front', 'Back'],
      ['reverse', 'Back', 'Front'],
    ]);
    expect(cards[0].line).toBe(2);
  });

  it('keeps fenced code with blank lines inside the answer', () => {
    const text = '#flashcards\nHow do you print in Python?\n?\n```python\nprint("a")\n\nprint("b::c")\n```\n';
    const [card] = parse(text);
    expect(card.back).toBe('```python\nprint("a")\n\nprint("b::c")\n```');
  });

  it('is the same card as the single-line form of the same question', () => {
    expect(parse('#flashcards\nQuestion\n?\nAnswer\n')[0].id).toBe(parse('#flashcards\nQuestion::Answer\n')[0].id);
  });
});

describe('clozes', () => {
  it('makes one card per deletion, showing the others', () => {
    const cards = parse('#flashcards\nThe first female ==prime minister== of Australia was ==Julia Gillard==\n');
    expect(cards.map((c) => c.front)).toEqual([
      `The first female ${clozeBlank(null)} of Australia was Julia Gillard`,
      `The first female prime minister of Australia was ${clozeBlank(null)}`,
    ]);
    expect(cards[1].back).toBe('The first female prime minister of Australia was ==Julia Gillard==');
    expect(cards[0].sibling).toBe(cards[1].sibling);
    expect(cards[0].hint).toBe('The first female [...] of Australia was Julia Gillard');
  });

  it('shows hints and groups numbered deletions', () => {
    const cards = parse('#flashcards\nThis is a ==cloze==^[a hint][^1]. This is ==too==[^2]. Asked ==together==[^1].\n');
    expect(cards).toHaveLength(2);
    expect(cards[0].front).toBe(`This is a ${clozeBlank('a hint')}. This is too. Asked ${clozeBlank(null)}.`);
    expect(cards[1].front).toBe(`This is a cloze. This is ${clozeBlank(null)}. Asked together.`);
    expect(cards[0].back).toBe('This is a ==cloze==. This is too. Asked ==together==.');
  });

  it('keeps the other deletions’ ids when one is added', () => {
    const before = parse('#flashcards\nWater boils at ==100== degrees ==Celsius==\n');
    const after = parse('#flashcards\n==Water== boils at ==100== degrees ==Celsius==\n');
    expect(after.map((c) => c.id)).toEqual(expect.arrayContaining(before.map((c) => c.id)));
  });

  it('escapes hints', () => {
    expect(clozeBlank('<b>')).toBe('<span class="fc-cloze">[&lt;b&gt;]</span>');
  });

  it('are not read in paragraphs that hold single-line cards', () => {
    expect(sides(parse('#flashcards\nQ::A with ==mark==\n'))).toEqual([['basic', 'Q', 'A with ==mark==']]);
  });
});

describe('decks', () => {
  it('follows frontmatter tags, deck lines and question-specific tags', () => {
    const text = [
      '---',
      'tags: [flashcards/main, other]',
      '---',
      'Q0::A0',
      '',
      '#flashcards/deckA',
      'Q1::A1',
      '#flashcards/deckB Q2::A2',
      'Q3::A3',
      '',
      '#flashcards/x #flashcards/y',
      'Q4::A4',
    ].join('\n');
    const cards = parse(text);
    expect(cards.map((c) => [c.front, c.decks])).toEqual([
      ['Q0', ['flashcards/main']],
      ['Q1', ['flashcards/deckA']],
      ['Q2', ['flashcards/deckB']],
      ['Q3', ['flashcards/deckA']],
      ['Q4', ['flashcards/x', 'flashcards/y']],
    ]);
    expect(cards[0].line).toBe(3);
  });

  it('gives cards before the first tag the note’s first flashcard tag', () => {
    expect(parse('Q::A\n\nmore text #flashcards/late\n')[0].decks).toEqual(['flashcards/late']);
  });

  it('matches any configured tag, ignoring case', () => {
    expect(parse('#SRS/Spanish\nhola::hello\n', 'n.md', { tags: ['srs'], foldersAsDecks: false })[0].decks).toEqual(['SRS/Spanish']);
  });

  it('uses the folder with foldersAsDecks', () => {
    const o = { tags: ['flashcards'], foldersAsDecks: true };
    expect(parse('Q::A\n', 'Lang/Spanish/Verbs.md', o)[0].decks).toEqual(['Lang/Spanish']);
    expect(parse('Q::A\n', 'Root.md', o)[0].decks).toEqual(['']);
  });

  it('records the headings a card is under', () => {
    const cards = parse('#flashcards\n# Trivia\n## Capitals\n### Africa\nKenya::Nairobi\n## Rivers\nNile::Africa\n');
    expect(cards.map((c) => c.context.filter(Boolean))).toEqual([
      ['Trivia', 'Capitals', 'Africa'],
      ['Trivia', 'Rivers'],
    ]);
  });
});

describe('ignored text', () => {
  it('skips cards in HTML comments (the plugin’s way to suspend a card) and %% blocks', () => {
    const text = '#flashcards\n<!--Old::card <!--SR:!2021-08-20,13,290--> -->\n<!--\nQ::A\n-->\n%%\nQ2::A2\n%%\nLive::card\n';
    expect(sides(parse(text))).toEqual([['basic', 'Live', 'card']]);
  });

  it('handles CRLF notes and a math block', () => {
    const text = '#flashcards\r\n$$\r\na::b\r\n$$\r\nQ::A\r\n';
    expect(sides(parse(text))).toEqual([['basic', 'Q', 'A']]);
  });

  it('dedupes a card written twice in one note', () => {
    expect(parse('#flashcards\nQ::A\n\nQ::B\n')).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('masks without changing the length', () => {
    const line = 'a `b::c` [[x::y]] %%z%% <!--w--> d';
    expect(maskLine(line)).toHaveLength(line.length);
    expect(maskLine(line).includes('::')).toBe(false);
  });

  it('normalizes card text and measures similarity', () => {
    expect(normalizeCardText('  a   b \n\n c <!--SR:!2021-08-20,13,290-->')).toBe('a b\nc');
    expect(similarity('What is the capital of France?', 'What is teh capital of France?')).toBeGreaterThan(0.9);
    expect(similarity('abc', 'xyz')).toBe(0);
    expect(similarity('', '')).toBe(1);
  });
});
