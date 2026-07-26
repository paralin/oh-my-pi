package scratchpkg

import "fmt"

// Budget tracks a spending limit in cents.
type Budget struct {
	// remaining is the balance left to spend, in cents.
	remaining int
}

// NewBudget returns a Budget with the given limit in cents, or an error if the limit is non-positive.
func NewBudget(limit int) (*Budget, error) {
	if limit <= 0 {
		return nil, fmt.Errorf("limit must be positive, got %d", limit)
	}
	return &Budget{remaining: limit}, nil
}

// Spend attempts to deduct amount cents from the budget and reports whether the spend succeeded.
func (b *Budget) Spend(amount int) bool {
	if amount > b.remaining {
		return false
	}
	b.remaining -= amount
	return true
}

// Balance reports the remaining balance in cents.
func (b *Budget) Balance() int {
	return b.remaining
}
