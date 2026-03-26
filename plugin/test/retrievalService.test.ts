import { assert } from "chai";
import type {
  PaperContextCandidate,
  PaperContextRef,
  PdfContext,
} from "../src/modules/contextPanel/types";
import { RetrievalService } from "../src/agent/services/retrievalService";

describe("RetrievalService", function () {
  it("keeps evidence-mode ordering instead of re-sorting by raw hybrid score", async function () {
    const paper: PaperContextRef = {
      itemId: 1,
      contextItemId: 11,
      title: "TEM",
      firstCreator: "Muller",
      year: "2020",
    };
    const pdfContext = {
      title: "Mock Paper",
      chunks: [],
      chunkMeta: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: 0,
      embeddingFailed: true,
    } as PdfContext;
    const abstractCandidate: PaperContextCandidate = {
      paperKey: "1:11",
      itemId: 1,
      contextItemId: 11,
      title: "TEM",
      firstCreator: "Muller",
      year: "2020",
      chunkIndex: 0,
      chunkText:
        "Abstract\nThe paper introduces the Tolman-Eichenbaum Machine and shows it generalizes structural maps across tasks.",
      chunkKind: "abstract",
      estimatedTokens: 18,
      bm25Score: 0.2,
      embeddingScore: 0,
      hybridScore: 0.2,
      evidenceScore: 1.1,
    };
    const captionCandidate: PaperContextCandidate = {
      paperKey: "1:11",
      itemId: 1,
      contextItemId: 11,
      title: "TEM",
      firstCreator: "Muller",
      year: "2020",
      chunkIndex: 1,
      chunkText:
        "Figure S7. The main contribution finding generalizes structural maps across tasks and environments.",
      chunkKind: "figure-caption",
      estimatedTokens: 14,
      bm25Score: 0.9,
      embeddingScore: 0,
      hybridScore: 0.9,
      evidenceScore: -0.2,
    };
    const retrieval = new RetrievalService(
      {
        ensurePaperContext: async () => pdfContext,
      } as any,
      async (_paperContext, _pdfContext, _question, _apiOverrides, options) => {
        assert.equal(options?.mode, "evidence");
        assert.equal(options?.topK, 2);
        return [captionCandidate, abstractCandidate];
      },
    );

    const results = await retrieval.retrieveEvidence({
      papers: [paper],
      question:
        "Summarize the paper in one sentence with the main contribution and finding.",
      topK: 2,
      perPaperTopK: 2,
    });

    assert.lengthOf(results, 2);
    assert.equal(results[0].chunkIndex, 0);
    assert.equal(results[0].chunkKind, "abstract");
    assert.equal(results[0].score, abstractCandidate.evidenceScore);
    assert.equal(results[1].chunkIndex, 1);
    assert.equal(results[1].chunkKind, "figure-caption");
    assert.equal(results[1].score, captionCandidate.evidenceScore);
    assert.isAbove(results[0].score, results[1].score);
  });
});
