// Ask your vault and summaries (ROADMAP item 18, DESIGN §6.21), through the extension points
// (§6.8): a right panel (the bottom sheet on phones), the page /x/ask (the phone's drawer entry and
// a ribbon button), and palette commands. The chat itself is a lazy chunk.
import { CalendarRange, FolderOpen, Lightbulb, Sparkles, TextSelect } from 'lucide-react';
import { toast } from '../../state/toasts';
import { registerCommand, registerPage, registerPanel } from '../../extensions';
import { aiEnabled, canSummarizeNote, folderOfNote, openAiView, selectedText, suggestForNote, summarizeFolder, summarizeNote, summarizeSelection, summarizeWeek } from './actions';

export function registerAi(): void {
  registerPanel({ id: 'ai', side: 'right', title: 'Ask', icon: Sparkles, load: () => import('./AiPanel') });
  registerPage({ route: 'ask', title: 'Ask your vault', icon: Sparkles, load: () => import('./AiPage') });

  registerCommand({ id: 'ai.ask', name: 'Ask a question about your notes', icon: Sparkles, run: openAiView });
  registerCommand({
    id: 'ai.summarizeNote',
    name: 'Summarize current note',
    icon: Sparkles,
    when: (c) => aiEnabled() && canSummarizeNote(c.activePath),
    run: (c) => summarizeNote(c.activePath!),
  });
  registerCommand({
    id: 'ai.suggest',
    name: 'Suggest links, tags and tasks for current note',
    icon: Lightbulb,
    when: (c) => aiEnabled() && canSummarizeNote(c.activePath),
    run: (c) => suggestForNote(c.activePath!),
  });
  registerCommand({
    id: 'ai.summarizeFolder',
    name: 'Summarize current folder',
    icon: FolderOpen,
    when: (c) => aiEnabled() && folderOfNote(c.activePath) !== null,
    run: (c) => summarizeFolder(folderOfNote(c.activePath)!),
  });
  registerCommand({
    id: 'ai.summarizeSelection',
    name: 'Summarize selection',
    icon: TextSelect,
    when: () => aiEnabled() && selectedText().trim() !== '',
    run: (c) => {
      summarizeSelection(c.activePath);
    },
  });
  registerCommand({
    id: 'ai.summarizeWeek',
    name: "Summarize this week's daily notes",
    icon: CalendarRange,
    when: () => aiEnabled(),
    run: () => {
      if (!summarizeWeek()) toast('There is no daily note this week yet');
    },
  });
}
