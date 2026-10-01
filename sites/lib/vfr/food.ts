/**
 * Documented keyword-table food classifier.
 *
 * Maps free-text food descriptions onto a category and a confirmation status
 * using a small, fully visible keyword table. There is deliberately no model
 * involved: a user can read the table and understand exactly why an event was
 * classified the way it was.
 *
 * This module inspects text only. When a source explicitly declares a category
 * or confirmation the normalizer prefers that declaration.
 */

import { FoodCategory, FoodConfirmed } from "./models.ts";

/**
 * Category keywords, ordered by specificity. A full-meal signal wins over a
 * snack signal because a served meal generally outranks snacks in ranking.
 * Matching is whole-word and case-insensitive.
 */
export const FULL_MEAL_KEYWORDS = [
  "dinner",
  "lunch",
  "breakfast",
  "brunch",
  "buffet",
  "meal",
  "pizza",
  "bbq",
  "barbecue",
  "tacos",
  "catered",
  "catering",
] as const;

export const SNACK_KEYWORDS = [
  "refreshments",
  "snacks",
  "snack",
  "coffee",
  "cookies",
  "appetizers",
  "bagels",
  "popcorn",
  "light bites",
  "desserts",
  "dessert",
  "treats",
] as const;

/** Explicit free-food language or concrete menu items confirm the food. */
export const FOOD_CONFIRMED_KEYWORDS = [
  "free food",
  "free pizza",
  "free lunch",
  "free dinner",
  "free breakfast",
  "food provided",
  "food will be provided",
  "lunch provided",
  "dinner provided",
  "breakfast provided",
  "refreshments provided",
  "snacks provided",
  "served",
  "catered",
  "menu",
] as const;

/**
 * Explicit statements that no food is available. Checked before the positive
 * keywords so "no free food" is never mistaken for a confirmation.
 */
export const FOOD_NEGATION_KEYWORDS = [
  "no free food",
  "no food",
  "food not provided",
  "food will not be provided",
  "byo",
  "bring your own",
] as const;

export type FoodClassification = {
  category: FoodCategory;
  confirmed: FoodConfirmed;
  /** The keywords that drove the decision, so the result stays explainable. */
  matchedKeywords: string[];
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `keyword` appears in `text` on word boundaries. Multi-word keywords
 * match as a contiguous phrase, and whole-word matching keeps "meal" from
 * matching "oatmeal".
 */
function containsWord(text: string, keyword: string): boolean {
  return new RegExp(`\\b${escapeRegExp(keyword)}\\b`).test(text);
}

/**
 * Classify a food description through the keyword table.
 *
 * Category: any full-meal keyword wins, else any snack keyword, else non-empty
 * text with no food keyword is `unspecified`, and absent text is `none`.
 *
 * Confirmation: any negation keyword contradicts, else any explicit
 * free-food/menu keyword confirms, else the claim is unconfirmed.
 */
export function classifyFood(description: string | null): FoodClassification {
  if (!description || !description.trim()) {
    return {
      category: FoodCategory.NONE,
      confirmed: FoodConfirmed.UNCONFIRMED,
      matchedKeywords: [],
    };
  }

  const text = description.toLowerCase();
  const matched: string[] = [];

  let category: FoodCategory = FoodCategory.UNSPECIFIED;
  const fullMealHits = FULL_MEAL_KEYWORDS.filter((kw) => containsWord(text, kw));
  const snackHits = SNACK_KEYWORDS.filter((kw) => containsWord(text, kw));
  if (fullMealHits.length > 0) {
    category = FoodCategory.FULL_MEAL;
    matched.push(...fullMealHits);
  } else if (snackHits.length > 0) {
    category = FoodCategory.SNACKS_OR_REFRESHMENTS;
    matched.push(...snackHits);
  }

  const negationHits = FOOD_NEGATION_KEYWORDS.filter((kw) => containsWord(text, kw));
  const confirmedHits = FOOD_CONFIRMED_KEYWORDS.filter((kw) => containsWord(text, kw));
  let confirmed: FoodConfirmed;
  if (negationHits.length > 0) {
    confirmed = FoodConfirmed.CONTRADICTED;
    matched.push(...negationHits);
  } else if (confirmedHits.length > 0) {
    confirmed = FoodConfirmed.CONFIRMED;
    matched.push(...confirmedHits);
  } else {
    confirmed = FoodConfirmed.UNCONFIRMED;
  }

  return {
    category,
    confirmed,
    matchedKeywords: [...new Set(matched)],
  };
}
