/**
 * The compile settings of this window: draft mode, and stopping on the first error. The compile
 * settings menu switches them (CompileManager.compileSettings), every compile of the window uses
 * them, and the window shows another client's build only if it was compiled with them
 * (ProjectBuilds, sameSettings).
 */
export const windowCompileSettings = {
    draft: false,
    stopOnFirstError: false,
};
