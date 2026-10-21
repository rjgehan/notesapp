// The right panel "Ask" (DESIGN §6.21); on phones it lives in the bottom sheet.
import { AiChat } from './AiChat';

export default function AiPanel({ activePath }: { activePath: string | null }) {
  return <AiChat activePath={activePath} variant="panel" />;
}
