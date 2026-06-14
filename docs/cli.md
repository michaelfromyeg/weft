# Weft CLI reference

_Generated from the CLI definition by `weft docs` -- do not edit by hand._

## `weft`

```
Author once, compile to every coding-agent harness. (weft v1.3.0)

USAGE `weft init|validate|build|install|uninstall|update|import|eval|publish|sign|verify|index|docs`

COMMANDS

       `init`    Scaffold a new plugin (weft.yaml + a sample skill)                               
   `validate`    Statically validate a plugin (the valid badge)                                   
      `build`    Compile a plugin (or a marketplace of plugins) to harness manifests              
    `install`    Compile + place a plugin (or a whole marketplace) into harness scopes            
  `uninstall`    Remove what install placed into this project (read from its weft.lock)           
     `update`    Re-resolve refs, recompile, and re-place only artifacts whose hash changed       
     `import`    Reverse-compile an existing native plugin/marketplace into a Weft plugin         
       `eval`    Run a component's evals against the real harnesses (reports UNTESTED honestly)   
    `publish`    Run the deterministic publish gate (static valid + trace/output evals)           
       `sign`    Sign weft.lock's artifact set (ed25519) -> weft.sig + weft.pub (the signed badge)
     `verify`    Verify weft.sig against weft.lock and the on-disk artifacts                      
      `index`    Build a metadata index from plugin dirs (optionally federating the MCP Registry) 
       `docs`    Print the full CLI reference (a CLI map), generated from the command tree        

Use `weft <command> --help` for more information about a command.
```

## `weft build`

Compile a plugin (or a marketplace of plugins) to harness manifests

```
Compile a plugin (or a marketplace of plugins) to harness manifests (weft build v1.3.0)

USAGE `weft build [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Local dir, or a remote ref (github:/npm:/owner/repo, optional //subdir)    

OPTIONS

  `--out=".weft-out"`    Output directory                                                                                                                                                                        
           `--target`    Comma-separated targets (default: all registered)                                                                                                                                       
             `--bare`    Write straight to --out without the <target>/ subdir (one --target only); e.g. `--target claude --out . --bare` makes a repo root a Claude marketplace                                  
            `--check`    Verify --out is already up to date with a fresh compile instead of writing (exit 1 on drift); the CI guard for a committed `--out . --bare` marketplace. Does not detect orphaned files.
```

## `weft docs`

Print the full CLI reference (a CLI map), generated from the command tree

```
Print the full CLI reference (a CLI map), generated from the command tree (weft docs v1.3.0)

USAGE `weft docs [OPTIONS] `

OPTIONS

  `--out`    Write the Markdown reference to this file instead of stdout
```

## `weft eval`

Run a component's evals against the real harnesses (reports UNTESTED honestly)

```
Run a component's evals against the real harnesses (reports UNTESTED honestly) (weft eval v1.3.0)

USAGE `weft eval [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Plugin directory    

OPTIONS

  `--component`    Only eval this component leaf name                                                       
    `--harness`    Restrict to these harnesses (comma-separated)                                            
    `--compare`    Vibes A/B: run each case against this git ref (or dir) and the working tree, side by side
```

## `weft import`

Reverse-compile an existing native plugin/marketplace into a Weft plugin

```
Reverse-compile an existing native plugin/marketplace into a Weft plugin (weft import v1.3.0)

USAGE `weft import [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Dir with an existing native plugin or marketplace    

OPTIONS

   `--from="claude"`    Source harness format                                 
  `--out="imported"`    Output directory                                      
       `--namespace`    Reverse-DNS namespace to assign (default com.imported)
```

## `weft index`

Build a metadata index from plugin dirs (optionally federating the MCP Registry)

```
Build a metadata index from plugin dirs (optionally federating the MCP Registry) (weft index v1.3.0)

USAGE `weft index [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Plugin directories    

OPTIONS

  `--out="index.json"`    Output index file                          
          `--federate`    Ingest the MCP Registry (GET /v0.1/servers)
```

## `weft init`

Scaffold a new plugin (weft.yaml + a sample skill)

```
Scaffold a new plugin (weft.yaml + a sample skill) (weft init v1.3.0)

USAGE `weft init [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Target directory    

OPTIONS

       `--name`    Plugin name (kebab-case)            
  `--namespace`    Reverse-DNS namespace, e.g. com.acme
```

## `weft install`

Compile + place a plugin (or a whole marketplace) into harness scopes

```
Compile + place a plugin (or a whole marketplace) into harness scopes (weft install v1.3.0)

USAGE `weft install [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Local dir, or a remote ref (github:/npm:/owner/repo, optional //subdir)    

OPTIONS

  `--scope="project"`    user | project                                                       
           `--target`    Comma-separated targets (default: all registered)                    
             `--only`    Comma-separated component names to install piecemeal (e.g. one skill)
              `--all`    Install to requested targets even if the harness is not detected     
          `--managed`    Managed mode: only allow these namespaces (comma-separated allowlist)
              `--cwd`    Project root for project-scope placement (default: cwd)
```

## `weft publish`

Run the deterministic publish gate (static valid + trace/output evals)

```
Run the deterministic publish gate (static valid + trace/output evals) (weft publish v1.3.0)

USAGE `weft publish [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Plugin directory    

OPTIONS

  `--snapshot`    Snapshot eval scores into evals/.baselines/ for the next release
```

## `weft sign`

Sign weft.lock's artifact set (ed25519) -> weft.sig + weft.pub (the signed badge)

```
Sign weft.lock's artifact set (ed25519) -> weft.sig + weft.pub (the signed badge) (weft sign v1.3.0)

USAGE `weft sign [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Plugin dir with weft.lock
```

## `weft uninstall`

Remove what install placed into this project (read from its weft.lock)

```
Remove what install placed into this project (read from its weft.lock) (weft uninstall v1.3.0)

USAGE `weft uninstall [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Install target holding weft.lock (default: derived from --scope)    

OPTIONS

  `--scope="project"`    user | project                                                
           `--plugin`    Remove only this plugin (id or bare name); default removes all
```

## `weft update`

Re-resolve refs, recompile, and re-place only artifacts whose hash changed

```
Re-resolve refs, recompile, and re-place only artifacts whose hash changed (weft update v1.3.0)

USAGE `weft update [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Plugin directory    

OPTIONS

  `--scope="project"`    user | project                                         
           `--target`    Comma-separated targets (default: all registered)      
              `--cwd`    Project root for project-scope placement (default: cwd)
```

## `weft validate`

Statically validate a plugin (the valid badge)

```
Statically validate a plugin (the valid badge) (weft validate v1.3.0)

USAGE `weft validate [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Plugin directory
```

## `weft verify`

Verify weft.sig against weft.lock and the on-disk artifacts

```
Verify weft.sig against weft.lock and the on-disk artifacts (weft verify v1.3.0)

USAGE `weft verify [OPTIONS] [DIR]`

ARGUMENTS

  `DIR="."`    Plugin dir with weft.lock
```

