// /x/ask (DESIGN §6.21): the conversation on a whole page, which is how the phone uses it. The
// "open note" is the last one opened on this device, since the page itself shows none.
import { useState } from 'react';
import { usePageTitle } from '../../components/pages/usePageTitle';
import { lastOpenedPath } from '../recent';
import { AiChat } from './AiChat';

export default function AiPage() {
  usePageTitle('Ask your vault');
  const [lastPath] = useState(lastOpenedPath);
  return (
    <div className="page ai-page">
      <AiChat activePath={lastPath} variant="page" />
    </div>
  );
}
