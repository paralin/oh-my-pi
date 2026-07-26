// Package scratchpkg is a bounded playground for flow-graph walks. It carries
// one small existing type so a walk can read the package's conventions before
// adding to it.
package scratchpkg

// Limits describes an inclusive numeric range.
type Limits struct {
	// Low is the smallest accepted value.
	Low int
	// High is the largest accepted value.
	High int
}

// Contains reports whether v falls inside the range.
func (l Limits) Contains(v int) bool {
	return v >= l.Low && v <= l.High
}
