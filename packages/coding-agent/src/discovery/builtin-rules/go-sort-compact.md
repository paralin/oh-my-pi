---
description: "Replace the canonical in-place sort-and-dedup helper with slices.Sort and slices.Compact"
scope: "tool:edit(*.go), tool:write(*.go)"
interruptMode: never
semanticCondition:
  candidate:
    ast: "func $NAME($KEYS []string) []string { sort.Strings($KEYS); $OUT := $KEYS[:0]; var $PREV string; for _, $KEY := range $KEYS { if $KEY == \"\" || $KEY == $PREV { continue }; $OUT = append($OUT, $KEY); $PREV = $KEY }; return $OUT }"
---

Replace this exact in-place `sort.Strings` plus adjacent-dedup helper with the standard `slices.Sort` and `slices.Compact` primitives.

```go
slices.Sort(keys)
keys = slices.Compact(keys)
if len(keys) != 0 && keys[0] == "" {
	keys = keys[1:]
}
```

The replacement is correct only when sorting makes duplicates adjacent and the operation may reuse the input slice storage. Preserve a seen-set implementation when original order matters, preserve explicit empty-string filtering when empty values are meaningful, and keep the helper when its name carries an independent domain rule. Comparator/equality variants (`slices.SortFunc` and `slices.CompactFunc`) require separate semantic review and are not claimed by this exact shape.
