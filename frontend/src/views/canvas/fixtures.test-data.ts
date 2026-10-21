// Canvas files as Obsidian writes them (tabs, one node or edge per line, no spaces, no final
// newline), with the fields newer Obsidian versions and plugins add, for round-trip tests.

export const OBSIDIAN_SAMPLE = [
  '{',
  '\t"nodes":[',
  '\t\t{"id":"754a8ef995f366bc","type":"group","x":-300,"y":-460,"width":610,"height":200,"label":"Project board"},',
  '\t\t{"id":"8132d4d894c80022","type":"file","file":"Projects/Plan.md","x":-280,"y":-200,"width":570,"height":560,"color":"6"},',
  '\t\t{"id":"7efdbbe0c4742315","type":"file","file":"Attachments/diagram.svg","x":-280,"y":-440,"width":217,"height":80},',
  '\t\t{"id":"59e896bc8da20699","type":"text","text":"Learn more:\\n\\n- [[Spec]]\\n- [Site](https://example.com) \\u2014 caf\\u00e9","x":40,"y":-440,"width":250,"height":160,"styleAttributes":{"border":"dashed"}},',
  '\t\t{"id":"0ba565e7f30e0652","type":"link","url":"https://obsidian.md","x":360,"y":-400,"width":400,"height":400,"color":"#ff8800"}',
  '\t],',
  '\t"edges":[',
  '\t\t{"id":"6fa11ab87f90b8af","fromNode":"7efdbbe0c4742315","fromSide":"right","toNode":"59e896bc8da20699","toSide":"left","label":"see also","styleAttributes":{"pathfindingMethod":"square"}},',
  '\t\t{"id":"a1b2c3d4e5f60718","fromNode":"59e896bc8da20699","fromSide":"bottom","fromEnd":"arrow","toNode":"0ba565e7f30e0652","toSide":"top","toEnd":"none","color":"2"}',
  '\t],',
  '\t"metadata":{"version":"1.0-1.0","frontmatter":{}}',
  '}',
].join('\n');

export const PRETTY_SAMPLE = `{
  "nodes": [
    {
      "id": "a",
      "type": "text",
      "text": "Hello",
      "x": 0,
      "y": 0,
      "width": 250,
      "height": 60,
      "plugin-data": [1, 2, 3]
    },
    {
      "id": "b",
      "type": "text",
      "text": "World",
      "x": 400,
      "y": 0,
      "width": 250,
      "height": 60
    }
  ],
  "edges": []
}
`;

export const COMPACT_SAMPLE = '{"edges":[{"id":"e","fromNode":"a","toNode":"b"}],"nodes":[{"id":"a","type":"text","text":"x","x":0,"y":0,"width":10,"height":10},{"id":"b","type":"text","text":"y","x":20,"y":0,"width":10,"height":10}]}';
