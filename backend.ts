import { ISourceNodeInstance, NodeCategory } from '@stoplight/graphite';
import { FilesystemNodeType } from '@stoplight/graphite/backends/filesystem';
import { KNOWN_RESOLVER_ERRORS } from '@stoplight/graphite/scheduler';
import { ResolverErrorCode } from '@stoplight/json-ref-resolver/types';
import { Activatable, DisposableCollection } from '@stoplight/lifecycle';
import {
  FormatLookup,
  IParsedResult,
  IRuleResult,
  isJSONSchema,
  isJSONSchemaDraft2019_09,
  isJSONSchemaDraft4,
  isJSONSchemaDraft6,
  isJSONSchemaDraft7,
  isJSONSchemaLoose,
  isOpenApiv2,
  isOpenApiv3,
  Spectral,
} from '@stoplight/spectral';
import { assertValidRuleset } from '@stoplight/spectral/dist/rulesets';
import { isDefaultRulesetFile } from '@stoplight/spectral/dist/rulesets/loader';
import { ValidationError } from '@stoplight/spectral/dist/rulesets/validation';
import { IDiagnostic } from '@stoplight/types';
import { observable } from 'mobx';
import { assertSourceNode } from '../../utils/assertions';
import { GraphWorker } from '../graph';
import { parserLookups } from '../graph/parser';
import { ISpectralMain, SpectralEvent } from './types';

Spectral.registerStaticAssets(require('@stoplight/spectral/rulesets/assets/assets.json'));

const KNOWN_FORMATS: Array<[string, FormatLookup]> = [
  ['oas2', isOpenApiv2],
  ['oas3', isOpenApiv3],
  ['json-schema', isJSONSchema],
  ['json-schema-loose', isJSONSchemaLoose],
  ['json-schema-draft4', isJSONSchemaDraft4],
  ['json-schema-draft6', isJSONSchemaDraft6],
  ['json-schema-draft7', isJSONSchemaDraft7],
  ['json-schema-2019-09', isJSONSchemaDraft2019_09],
];

export class SpectralWorker extends Activatable {
  private _spectral!: Spectral;

  @observable.ref
  private _rulesetNode: ISourceNodeInstance | null = null;

  @observable
  private _lintedNodeId: string | null = null;

  private _lintTimeout: NodeJS.Timeout | null = null;

  constructor(private _client: ISpectralMain, private _graphWorker: GraphWorker) {
    super();
  }

  private _getDefaultSpectralConfig(): ISourceNodeInstance | null {
    if (!this._graphWorker || !this._graphWorker.graph) return null;
    const rootNode = this._graphWorker.graph.getNodeByUri(this._graphWorker.cwd);
    if (!rootNode || rootNode.category !== NodeCategory.Source) return null;
    for (const child of rootNode.children) {
      if (child.type !== FilesystemNodeType.File || child.category !== NodeCategory.Source) continue;
      if (isDefaultRulesetFile(child.path)) {
        return child;
      }
    }

    return null;
  }

  private _createSpectralInstance() {
    this._spectral = new Spectral({
      resolver: {
        resolve: async () => {
          if (this._lintedNodeId === null) {
            throw new Error('LintedNodeId is null');
          }

          const node = assertSourceNode(
            await this._graphWorker.getNodeById(this._lintedNodeId),
            this._lintedNodeId,
            this._graphWorker,
          );

          if (node.data.refGraph === void 0) {
            throw new Error('refGraph is unavailable');
          }

          return {
            refMap: node.data.refMap || {},
            result: node.data.resolved,
            errors: [],
            graph: node.data.refGraph,
          };
        },
      },
    });

    for (const [format, lookup] of KNOWN_FORMATS) {
      this._spectral.registerFormat(format, lookup);
    }

    this._client.emit(SpectralEvent.SpectralInitialized, {
      registeredFormats: Object.keys(this._spectral.formats),
    });
  }

  public async validateRuleset(): Promise<IDiagnostic[]> {
    const { _rulesetNode: ruleset } = this;
    if (ruleset !== null) {
      try {
        assertValidRuleset(ruleset.data.parsed);
      } catch (ex) {
        if (ex.ajv && ex.errors) {
          return Promise.all(
            (ex as ValidationError).errors.map(error => {
              const path = error.dataPath.slice(1).split('/');
              return this._createRulesetError(ruleset.id, path, error.message);
            }),
          );
        }

        return [await this._createRulesetError(ruleset.id, [], ex.message)];
      }
    }

    return [];
  }

  private async _loadRuleset() {
    try {
      this._createSpectralInstance();

      if (this._rulesetNode === null) {
        await this._spectral.loadRuleset('spectral:oas');
      } else {
        await this._spectral.loadRuleset(this._rulesetNode.uri, { timeout: 5000 });
      }

      this._client.emit(SpectralEvent.LoadRuleset, null, this._getActiveRuleset(this._spectral));
    } catch (ex) {
      this._client.emit(SpectralEvent.LoadRuleset, ex.message, null);
    }
  }

  private async _lint(nodeId: string, timeout = 500) {
    this._clearTimeout();

    this._lintTimeout = setTimeout(async () => {
      try {
        const node = assertSourceNode(await this._graphWorker.getNodeById(nodeId), nodeId, this._graphWorker);

        const results = (await this.run(node.id))
          .filter(({ source }) => source === node.uri)
          .map(error => ({
            ...error,
            source: 'spectral',
          }));

        const existingDiagnostics = node.data.diagnostics.filter(
          ({ source, code }) =>
            source !== 'spectral' ||
            (code !== void 0 && KNOWN_RESOLVER_ERRORS.includes(String(code) as ResolverErrorCode)), // resolve.resolve returns no errors (we could return some, but not point)
        );

        if (this._graphWorker && this._graphWorker.graph) {
          this._graphWorker.graph.setSourceNodeProp(node.id, 'data.diagnostics', [...existingDiagnostics, ...results]);
        }
      } catch {
        // todo: send warning/anomaly/event/metric?
        // happens
      } finally {
        this._lintTimeout = null;
      }
    }, timeout);
  }

  public async run(nodeId: string): Promise<IRuleResult[]> {
    if (!this._spectral) {
      await this._createSpectralInstance();
    }

    const node = assertSourceNode(this._graphWorker.getNodeById(nodeId));

    const parserResult: IParsedResult = {
      parsed: {
        data: node.data.parsed,
        ast: node.data.ast!,
        lineMap: node.data.lineMap,
        diagnostics: [],
      },
      getLocationForJsonPath: parserLookups[node.language].getLocationForJsonPath,
      source: node.uri,
    };

    return await this._spectral.run(parserResult, {
      resolve: {
        documentUri: node.uri,
      },
    });
  }
}
