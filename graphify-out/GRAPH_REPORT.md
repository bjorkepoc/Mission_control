# Graph Report - /home/clawd/.openclaw/workspace/mission-control  (2026-04-23)

## Corpus Check
- 1 files · ~46,975 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 18 nodes · 34 edges · 3 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]

## God Nodes (most connected - your core abstractions)
1. `transform()` - 16 edges
2. `getPaths()` - 3 edges
3. `log()` - 3 edges
4. `fetchTasksFromGitHub()` - 3 edges
5. `loadConfig()` - 2 edges
6. `extractRepoInfo()` - 2 edges
7. `getGitHubToken()` - 2 edges
8. `verifyHmac()` - 2 edges
9. `wakeAgent()` - 2 edges
10. `sendSlackMessage()` - 2 edges

## Surprising Connections (you probably didn't know these)
- `transform()` --calls--> `getPaths()`  [EXTRACTED]
  /home/clawd/.openclaw/workspace/mission-control/transforms/github-mission-control.mjs → /home/clawd/.openclaw/workspace/mission-control/transforms/github-mission-control.mjs  _Bridges community 1 → community 0_
- `transform()` --calls--> `fetchTasksFromGitHub()`  [EXTRACTED]
  /home/clawd/.openclaw/workspace/mission-control/transforms/github-mission-control.mjs → /home/clawd/.openclaw/workspace/mission-control/transforms/github-mission-control.mjs  _Bridges community 2 → community 0_

## Communities

### Community 0 - "Community 0"
Cohesion: 0.27
Nodes (13): calculateDiff(), extractRepoInfo(), findChildTasks(), formatEpicWorkOrder(), formatNotification(), formatStartNotification(), formatWorkOrder(), isEpic() (+5 more)

### Community 1 - "Community 1"
Cohesion: 1.0
Nodes (2): getPaths(), log()

### Community 2 - "Community 2"
Cohesion: 1.0
Nodes (2): fetchTasksFromGitHub(), getGitHubToken()

## Knowledge Gaps
- **Thin community `Community 1`** (2 nodes): `getPaths()`, `log()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 2`** (2 nodes): `fetchTasksFromGitHub()`, `getGitHubToken()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `transform()` connect `Community 0` to `Community 1`, `Community 2`?**
  _High betweenness centrality (0.382) - this node is a cross-community bridge._
- **Why does `fetchTasksFromGitHub()` connect `Community 2` to `Community 0`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._