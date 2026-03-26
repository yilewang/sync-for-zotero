import { assert } from "chai";
import { isReasoningDisplayLabelActive } from "../src/modules/contextPanel/setupHandlers/controllers/modelReasoningController";

describe("modelReasoningController", function () {
  describe("isReasoningDisplayLabelActive", function () {
    it("treats off-like labels as inactive", function () {
      assert.isFalse(isReasoningDisplayLabelActive("off"));
      assert.isFalse(isReasoningDisplayLabelActive(" Off "));
      assert.isFalse(isReasoningDisplayLabelActive("disabled"));
    });

    it("keeps active labels active", function () {
      assert.isTrue(isReasoningDisplayLabelActive("dynamic"));
      assert.isTrue(isReasoningDisplayLabelActive("enabled"));
      assert.isTrue(isReasoningDisplayLabelActive("24576"));
    });
  });
});
