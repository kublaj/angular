/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {SchemaMetadata} from '@angular/core';

import {AnimationCompiler} from '../animation/animation_compiler';
import {AnimationParser} from '../animation/animation_parser';
import {CompileDirectiveMetadata, CompileIdentifierMetadata, CompileNgModuleMetadata, CompilePipeMetadata, CompileProviderMetadata, createHostComponentMeta, identifierModuleUrl, identifierName} from '../compile_metadata';
import {DirectiveNormalizer} from '../directive_normalizer';
import {DirectiveWrapperCompileResult, DirectiveWrapperCompiler} from '../directive_wrapper_compiler';
import {ListWrapper} from '../facade/collection';
import {Identifiers, createIdentifier, createIdentifierToken} from '../identifiers';
import {CompileMetadataResolver} from '../metadata_resolver';
import {NgModuleCompiler} from '../ng_module_compiler';
import {OutputEmitter} from '../output/abstract_emitter';
import * as o from '../output/output_ast';
import {CompiledStylesheet, StyleCompiler} from '../style_compiler';
import {TemplateParser} from '../template_parser/template_parser';
import {ComponentFactoryDependency, DirectiveWrapperDependency, ViewClassDependency, ViewCompileResult, ViewCompiler} from '../view_compiler/view_compiler';

import {AotCompilerOptions} from './compiler_options';
import {StaticReflector} from './static_reflector';
import {StaticSymbol} from './static_symbol';

export class SourceModule {
  constructor(public fileUrl: string, public moduleUrl: string, public source: string) {}
}

export class AotCompiler {
  private _animationCompiler = new AnimationCompiler();

  constructor(
      private _metadataResolver: CompileMetadataResolver, private _templateParser: TemplateParser,
      private _styleCompiler: StyleCompiler, private _viewCompiler: ViewCompiler,
      private _dirWrapperCompiler: DirectiveWrapperCompiler,
      private _ngModuleCompiler: NgModuleCompiler, private _outputEmitter: OutputEmitter,
      private _localeId: string, private _translationFormat: string,
      private _animationParser: AnimationParser, private _staticReflector: StaticReflector,
      private _options: AotCompilerOptions) {}

  clearCache() { this._metadataResolver.clearCache(); }

  compileAll(rootFiles: string[]): Promise<SourceModule[]> {
    const programSymbols = extractProgramSymbols(this._staticReflector, rootFiles, this._options);
    const {ngModuleByPipeOrDirective, files, ngModules} =
        analyzeAndValidateNgModules(programSymbols, this._options, this._metadataResolver);
    return loadNgModuleDirectives(ngModules).then(() => {
      const sourceModules = files.map(
          file => this._compileSrcFile(
              file.srcUrl, ngModuleByPipeOrDirective, file.directives, file.ngModules));
      return ListWrapper.flatten(sourceModules);
    });
  }

  private _compileSrcFile(
      srcFileUrl: string, ngModuleByPipeOrDirective: Map<StaticSymbol, CompileNgModuleMetadata>,
      directives: StaticSymbol[], ngModules: StaticSymbol[]): SourceModule[] {
    const fileSuffix = _splitTypescriptSuffix(srcFileUrl)[1];
    const statements: o.Statement[] = [];
    const exportedVars: string[] = [];
    const outputSourceModules: SourceModule[] = [];

    // compile all ng modules
    exportedVars.push(
        ...ngModules.map((ngModuleType) => this._compileModule(ngModuleType, statements)));

    // compile directive wrappers
    exportedVars.push(...directives.map(
        (directiveType) => this._compileDirectiveWrapper(directiveType, statements)));

    // compile components
    directives.forEach((dirType) => {
      const compMeta = this._metadataResolver.getDirectiveMetadata(<any>dirType);
      if (!compMeta.isComponent) {
        return Promise.resolve(null);
      }
      const ngModule = ngModuleByPipeOrDirective.get(dirType);
      if (!ngModule) {
        throw new Error(
            `Internal Error: cannot determine the module for component ${identifierName(compMeta.type)}!`);
      }

      _assertComponent(compMeta);

      // compile styles
      const stylesCompileResults = this._styleCompiler.compileComponent(compMeta);
      stylesCompileResults.externalStylesheets.forEach((compiledStyleSheet) => {
        outputSourceModules.push(this._codgenStyles(srcFileUrl, compiledStyleSheet, fileSuffix));
      });

      // compile components
      exportedVars.push(
          this._compileComponentFactory(compMeta, ngModule, fileSuffix, statements),
          this._compileComponent(
              compMeta, ngModule, ngModule.transitiveModule.directives,
              stylesCompileResults.componentStylesheet, fileSuffix, statements));
    });
    if (statements.length > 0) {
      const srcModule = this._codegenSourceModule(
          srcFileUrl, _ngfactoryModuleUrl(srcFileUrl), statements, exportedVars);
      outputSourceModules.unshift(srcModule);
    }
    return outputSourceModules;
  }

  private _compileModule(ngModuleType: StaticSymbol, targetStatements: o.Statement[]): string {
    const ngModule = this._metadataResolver.getNgModuleMetadata(ngModuleType);
    const providers: CompileProviderMetadata[] = [];

    if (this._localeId) {
      providers.push({
        token: createIdentifierToken(Identifiers.LOCALE_ID),
        useValue: this._localeId,
      });
    }

    if (this._translationFormat) {
      providers.push({
        token: createIdentifierToken(Identifiers.TRANSLATIONS_FORMAT),
        useValue: this._translationFormat
      });
    }

    const appCompileResult = this._ngModuleCompiler.compile(ngModule, providers);

    appCompileResult.dependencies.forEach((dep) => {
      dep.placeholder.reference = this._staticReflector.getStaticSymbol(
          _ngfactoryModuleUrl(identifierModuleUrl(dep.comp)), _componentFactoryName(dep.comp));
    });

    targetStatements.push(...appCompileResult.statements);
    return appCompileResult.ngModuleFactoryVar;
  }

  private _compileDirectiveWrapper(directiveType: StaticSymbol, targetStatements: o.Statement[]):
      string {
    const dirMeta = this._metadataResolver.getDirectiveMetadata(directiveType);
    const dirCompileResult = this._dirWrapperCompiler.compile(dirMeta);

    targetStatements.push(...dirCompileResult.statements);
    return dirCompileResult.dirWrapperClassVar;
  }

  private _compileComponentFactory(
      compMeta: CompileDirectiveMetadata, ngModule: CompileNgModuleMetadata, fileSuffix: string,
      targetStatements: o.Statement[]): string {
    const hostMeta = createHostComponentMeta(
        this._staticReflector.getStaticSymbol(
            identifierModuleUrl(compMeta.type), `${identifierName(compMeta.type)}_Host`),
        compMeta);
    const hostViewFactoryVar = this._compileComponent(
        hostMeta, ngModule, [compMeta.type], null, fileSuffix, targetStatements);
    const compFactoryVar = _componentFactoryName(compMeta.type);
    targetStatements.push(
        o.variable(compFactoryVar)
            .set(o.importExpr(
                      createIdentifier(Identifiers.ComponentFactory), [o.importType(compMeta.type)])
                     .instantiate(
                         [
                           o.literal(compMeta.selector),
                           o.variable(hostViewFactoryVar),
                           o.importExpr(compMeta.type),
                         ],
                         o.importType(
                             createIdentifier(Identifiers.ComponentFactory),
                             [o.importType(compMeta.type)], [o.TypeModifier.Const])))
            .toDeclStmt(null, [o.StmtModifier.Final]));
    return compFactoryVar;
  }

  private _compileComponent(
      compMeta: CompileDirectiveMetadata, ngModule: CompileNgModuleMetadata,
      directiveIdentifiers: CompileIdentifierMetadata[], componentStyles: CompiledStylesheet,
      fileSuffix: string, targetStatements: o.Statement[]): string {
    const parsedAnimations = this._animationParser.parseComponent(compMeta);
    const directives =
        directiveIdentifiers.map(dir => this._metadataResolver.getDirectiveSummary(dir.reference));
    const pipes = ngModule.transitiveModule.pipes.map(
        pipe => this._metadataResolver.getPipeSummary(pipe.reference));

    const parsedTemplate = this._templateParser.parse(
        compMeta, compMeta.template.template, directives, pipes, ngModule.schemas,
        identifierName(compMeta.type));
    const stylesExpr = componentStyles ? o.variable(componentStyles.stylesVar) : o.literalArr([]);
    const compiledAnimations =
        this._animationCompiler.compile(identifierName(compMeta.type), parsedAnimations);
    const viewResult = this._viewCompiler.compileComponent(
        compMeta, parsedTemplate, stylesExpr, pipes, compiledAnimations);
    if (componentStyles) {
      targetStatements.push(
          ..._resolveStyleStatements(this._staticReflector, componentStyles, fileSuffix));
    }
    compiledAnimations.forEach(entry => targetStatements.push(...entry.statements));
    targetStatements.push(..._resolveViewStatements(this._staticReflector, viewResult));
    return viewResult.viewClassVar;
  }

  private _codgenStyles(
      fileUrl: string, stylesCompileResult: CompiledStylesheet, fileSuffix: string): SourceModule {
    _resolveStyleStatements(this._staticReflector, stylesCompileResult, fileSuffix);
    return this._codegenSourceModule(
        fileUrl, _stylesModuleUrl(
                     stylesCompileResult.meta.moduleUrl, stylesCompileResult.isShimmed, fileSuffix),
        stylesCompileResult.statements, [stylesCompileResult.stylesVar]);
  }

  private _codegenSourceModule(
      fileUrl: string, moduleUrl: string, statements: o.Statement[],
      exportedVars: string[]): SourceModule {
    return new SourceModule(
        fileUrl, moduleUrl,
        this._outputEmitter.emitStatements(moduleUrl, statements, exportedVars));
  }
}

function _resolveViewStatements(
    reflector: StaticReflector, compileResult: ViewCompileResult): o.Statement[] {
  compileResult.dependencies.forEach((dep) => {
    if (dep instanceof ViewClassDependency) {
      const vfd = <ViewClassDependency>dep;
      vfd.placeholder.reference =
          reflector.getStaticSymbol(_ngfactoryModuleUrl(identifierModuleUrl(vfd.comp)), dep.name);
    } else if (dep instanceof ComponentFactoryDependency) {
      const cfd = <ComponentFactoryDependency>dep;
      cfd.placeholder.reference = reflector.getStaticSymbol(
          _ngfactoryModuleUrl(identifierModuleUrl(cfd.comp)), _componentFactoryName(cfd.comp));
    } else if (dep instanceof DirectiveWrapperDependency) {
      const dwd = <DirectiveWrapperDependency>dep;
      dwd.placeholder.reference =
          reflector.getStaticSymbol(_ngfactoryModuleUrl(identifierModuleUrl(dwd.dir)), dwd.name);
    }
  });
  return compileResult.statements;
}


function _resolveStyleStatements(
    reflector: StaticReflector, compileResult: CompiledStylesheet,
    fileSuffix: string): o.Statement[] {
  compileResult.dependencies.forEach((dep) => {
    dep.valuePlaceholder.reference = reflector.getStaticSymbol(
        _stylesModuleUrl(dep.moduleUrl, dep.isShimmed, fileSuffix), dep.name);
  });
  return compileResult.statements;
}

function _ngfactoryModuleUrl(dirUrl: string): string {
  const urlWithSuffix = _splitTypescriptSuffix(dirUrl);
  return `${urlWithSuffix[0]}.ngfactory${urlWithSuffix[1]}`;
}

function _componentFactoryName(comp: CompileIdentifierMetadata): string {
  return `${identifierName(comp)}NgFactory`;
}

function _stylesModuleUrl(stylesheetUrl: string, shim: boolean, suffix: string): string {
  return shim ? `${stylesheetUrl}.shim${suffix}` : `${stylesheetUrl}${suffix}`;
}

function _assertComponent(meta: CompileDirectiveMetadata) {
  if (!meta.isComponent) {
    throw new Error(
        `Could not compile '${identifierName(meta.type)}' because it is not a component.`);
  }
}

function _splitTypescriptSuffix(path: string): string[] {
  if (path.endsWith('.d.ts')) {
    return [path.slice(0, -5), '.ts'];
  }

  const lastDot = path.lastIndexOf('.');

  if (lastDot !== -1) {
    return [path.substring(0, lastDot), path.substring(lastDot)];
  }

  return [path, ''];
}

export interface NgAnalyzedModules {
  ngModules: CompileNgModuleMetadata[];
  ngModuleByPipeOrDirective: Map<StaticSymbol, CompileNgModuleMetadata>;
  files: Array<{srcUrl: string, directives: StaticSymbol[], ngModules: StaticSymbol[]}>;
  symbolsMissingModule?: StaticSymbol[];
}

// Returns all the source files and a mapping from modules to directives
export function analyzeNgModules(
    programStaticSymbols: StaticSymbol[],
    options: {includeFilePattern?: RegExp, excludeFilePattern?: RegExp},
    metadataResolver: CompileMetadataResolver): NgAnalyzedModules {
  const {ngModules, symbolsMissingModule} =
      _createNgModules(programStaticSymbols, options, metadataResolver);
  return _analyzeNgModules(ngModules, symbolsMissingModule);
}

export function analyzeAndValidateNgModules(
    programStaticSymbols: StaticSymbol[],
    options: {includeFilePattern?: RegExp, excludeFilePattern?: RegExp},
    metadataResolver: CompileMetadataResolver): NgAnalyzedModules {
  const result = analyzeNgModules(programStaticSymbols, options, metadataResolver);
  if (result.symbolsMissingModule && result.symbolsMissingModule.length) {
    const messages = result.symbolsMissingModule.map(
        s => `Cannot determine the module for class ${s.name} in ${s.filePath}!`);
    throw new Error(messages.join('\n'));
  }
  return result;
}

// Wait for the directives in the given modules have been loaded
export function loadNgModuleDirectives(ngModules: CompileNgModuleMetadata[]) {
  return Promise
      .all(ListWrapper.flatten(ngModules.map(
          (ngModule) => ngModule.transitiveModule.directiveLoaders.map(loader => loader()))))
      .then(() => {});
}

function _analyzeNgModules(
    ngModuleMetas: CompileNgModuleMetadata[],
    symbolsMissingModule: StaticSymbol[]): NgAnalyzedModules {
  const moduleMetasByRef = new Map<any, CompileNgModuleMetadata>();
  ngModuleMetas.forEach((ngModule) => moduleMetasByRef.set(ngModule.type.reference, ngModule));
  const ngModuleByPipeOrDirective = new Map<StaticSymbol, CompileNgModuleMetadata>();
  const ngModulesByFile = new Map<string, StaticSymbol[]>();
  const ngDirectivesByFile = new Map<string, StaticSymbol[]>();
  const filePaths = new Set<string>();

  // Looping over all modules to construct:
  // - a map from file to modules `ngModulesByFile`,
  // - a map from file to directives `ngDirectivesByFile`,
  // - a map from directive/pipe to module `ngModuleByPipeOrDirective`.
  ngModuleMetas.forEach((ngModuleMeta) => {
    const srcFileUrl = ngModuleMeta.type.reference.filePath;
    filePaths.add(srcFileUrl);
    ngModulesByFile.set(
        srcFileUrl, (ngModulesByFile.get(srcFileUrl) || []).concat(ngModuleMeta.type.reference));

    ngModuleMeta.declaredDirectives.forEach((dirIdentifier) => {
      const fileUrl = dirIdentifier.reference.filePath;
      filePaths.add(fileUrl);
      ngDirectivesByFile.set(
          fileUrl, (ngDirectivesByFile.get(fileUrl) || []).concat(dirIdentifier.reference));
      ngModuleByPipeOrDirective.set(dirIdentifier.reference, ngModuleMeta);
    });
    ngModuleMeta.declaredPipes.forEach((pipeIdentifier) => {
      const fileUrl = pipeIdentifier.reference.filePath;
      filePaths.add(fileUrl);
      ngModuleByPipeOrDirective.set(pipeIdentifier.reference, ngModuleMeta);
    });
  });

  const files: {srcUrl: string, directives: StaticSymbol[], ngModules: StaticSymbol[]}[] = [];

  filePaths.forEach((srcUrl) => {
    const directives = ngDirectivesByFile.get(srcUrl) || [];
    const ngModules = ngModulesByFile.get(srcUrl) || [];
    files.push({srcUrl, directives, ngModules});
  });

  return {
    // map directive/pipe to module
    ngModuleByPipeOrDirective,
    // list modules and directives for every source file
    files,
    ngModules: ngModuleMetas, symbolsMissingModule
  };
}

export function extractProgramSymbols(
    staticReflector: StaticReflector, files: string[],
    options: {includeFilePattern?: RegExp, excludeFilePattern?: RegExp} = {}): StaticSymbol[] {
  const staticSymbols: StaticSymbol[] = [];
  files.filter(fileName => _filterFileByPatterns(fileName, options)).forEach(sourceFile => {
    const moduleMetadata = staticReflector.getModuleMetadata(sourceFile);
    if (!moduleMetadata) {
      console.error(`WARNING: no metadata found for ${sourceFile}`);
      return;
    }

    const metadata = moduleMetadata['metadata'];

    if (!metadata) {
      return;
    }

    for (const symbol of Object.keys(metadata)) {
      if (metadata[symbol] && metadata[symbol].__symbolic == 'error') {
        // Ignore symbols that are only included to record error information.
        continue;
      }
      staticSymbols.push(staticReflector.getStaticSymbol(sourceFile, symbol));
    }
  });

  return staticSymbols;
}

// Load the NgModules and check
// that all directives / pipes that are present in the program
// are also declared by a module.
function _createNgModules(
    programStaticSymbols: StaticSymbol[],
    options: {includeFilePattern?: RegExp, excludeFilePattern?: RegExp},
    metadataResolver: CompileMetadataResolver):
    {ngModules: CompileNgModuleMetadata[], symbolsMissingModule: StaticSymbol[]} {
  const ngModules = new Map<any, CompileNgModuleMetadata>();
  const programPipesAndDirectives: StaticSymbol[] = [];
  const ngModulePipesAndDirective = new Set<StaticSymbol>();

  const addNgModule = (staticSymbol: any) => {
    if (ngModules.has(staticSymbol) || !_filterFileByPatterns(staticSymbol.filePath, options)) {
      return false;
    }
    const ngModule = metadataResolver.getUnloadedNgModuleMetadata(staticSymbol, false, false);
    if (ngModule) {
      ngModules.set(ngModule.type.reference, ngModule);
      ngModule.declaredDirectives.forEach((dir) => ngModulePipesAndDirective.add(dir.reference));
      ngModule.declaredPipes.forEach((pipe) => ngModulePipesAndDirective.add(pipe.reference));
      // For every input module add the list of transitively included modules
      ngModule.transitiveModule.modules.forEach(modMeta => addNgModule(modMeta.type.reference));
    }
    return !!ngModule;
  };
  programStaticSymbols.forEach((staticSymbol) => {
    if (!addNgModule(staticSymbol) &&
        (metadataResolver.isDirective(staticSymbol) || metadataResolver.isPipe(staticSymbol))) {
      programPipesAndDirectives.push(staticSymbol);
    }
  });

  // Throw an error if any of the program pipe or directives is not declared by a module
  const symbolsMissingModule =
      programPipesAndDirectives.filter(s => !ngModulePipesAndDirective.has(s));

  return {ngModules: Array.from(ngModules.values()), symbolsMissingModule};
}

function _filterFileByPatterns(
    fileName: string, options: {includeFilePattern?: RegExp, excludeFilePattern?: RegExp} = {}) {
  let match = true;
  if (options.includeFilePattern) {
    match = match && !!options.includeFilePattern.exec(fileName);
  }
  if (options.excludeFilePattern) {
    match = match && !options.excludeFilePattern.exec(fileName);
  }
  return match;
}