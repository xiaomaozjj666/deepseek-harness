/** Vite adapters for recording product chunk, asset, CSS, and worker inputs. */

import type { Plugin } from 'vite'
import { WebProductBundleIsolation } from '../../scripts/web-product-bundle-isolation.ts'

const DEPENDENCY_ANALYSIS_PLUGIN = 'dsh-browser-dependency-analysis'

/**
 * Identify a dependency-disclosure walk that deliberately leaves third-party imports external.
 * @returns Analysis intent that refuses builds which can write output.
 */
export function browserDependencyAnalysis(): Plugin {
  return {
    name: DEPENDENCY_ANALYSIS_PLUGIN,
    apply: 'build',
    configResolved(config) { requireNonWritingAnalysis(config.build.write) },
  }
}

function requireNonWritingAnalysis(write: boolean): void {
  if (write !== false) throw new Error('browser dependency analysis requires build.write: false')
}

/**
 * Reject experimental inputs reachable from the built default Web page.
 * @param repository - repository root supplying package ownership.
 * @param webRoot - Vite root containing index.html and public assets.
 * @returns Build plugins that preserve Vite's output and fail before publication on a violation.
 */
export function productWebBundleIsolation(repository: string, webRoot: string): Plugin[] {
  const inputs = new WebProductBundleIsolation(repository, webRoot)
  let dependencyAnalysis = false
  return [{
    name: 'dsh-product-web-chunk-inputs',
    apply: 'build',
    generateBundle: {
      order: 'pre',
      handler(_options, bundle) {
        if (!dependencyAnalysis) inputs.captureChunks(bundle)
      },
    },
  }, {
    name: 'dsh-product-web-bundle-isolation',
    apply: 'build',
    enforce: 'post',
    config(config) {
      const renderBuiltUrl = config.experimental?.renderBuiltUrl
      const workerPlugins = config.worker?.plugins
      return {
        experimental: {
          renderBuiltUrl(filename, context) {
            inputs.assetReference(filename, context.hostId, context.type)
            return renderBuiltUrl?.(filename, context)
          },
        },
        worker: {
          plugins: () => [...workerPlugins?.() ?? [], {
            name: 'dsh-worker-build-inputs',
            generateBundle: {
              order: 'post',
              handler(_options, bundle) { inputs.workerBundle(bundle, [...this.getModuleIds()]) },
            },
          }],
        },
      }
    },
    configResolved(config) {
      dependencyAnalysis = config.plugins.some(plugin => plugin.name === DEPENDENCY_ANALYSIS_PLUGIN)
      if (dependencyAnalysis) {
        requireNonWritingAnalysis(config.build.write)
        return
      }
      const cssPlugins = config.plugins.filter(plugin => plugin.name === 'vite:css')
      const css = cssPlugins[0]
      if (cssPlugins.length !== 1 || css?.transform === undefined) {
        throw new Error('Web product isolation: Vite CSS input instrumentation is unavailable')
      }
      const transform = typeof css.transform === 'function' ? css.transform : css.transform.handler
      css.transform = {
        ...typeof css.transform === 'function' ? {} : css.transform,
        handler(code, id, options) {
          inputs.cssTransform(id)
          const context = new Proxy(this, {
            get(target, property) {
              if (property === 'addWatchFile') return (file: string): void => {
                inputs.cssDependency(id, file)
                target.addWatchFile(file)
              }
              const value: unknown = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
          return transform.call(context, code, id, options)
        },
      }
    },
    buildStart() { inputs.reset() },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        if (!dependencyAnalysis) {
          // Rolldown's ModuleInfo type dropped isExternal/isIncluded while
          // Vite still populates both at runtime (its rollup-compat layer).
          // Read them into an optional-field view instead of casting through
          // `unknown`: the assertion gate forbids that escape, and the
          // defaults below reproduce what an absent field meant before.
          inputs.verify(bundle, (id) => {
            const info = this.getModuleInfo(id)
            if (info === null) return null
            // Rolldown's ModuleInfo type omits isExternal/isIncluded while
            // Vite still populates both at runtime (its rollup-compat layer),
            // so narrow them with `in` instead of escaping through `unknown`
            // (forbidden by the assertion gate). Absent fields keep their
            // previous falsy meaning.
            const isExternal = 'isExternal' in info && typeof info.isExternal === 'boolean' ? info.isExternal : false
            const isIncluded = 'isIncluded' in info && typeof info.isIncluded === 'boolean' ? info.isIncluded : null
            return {
              importedIds: info.importedIds,
              dynamicallyImportedIds: info.dynamicallyImportedIds,
              isExternal,
              isIncluded,
            }
          })
        }
      },
    },
  }]
}
