"""Validate test declarations with AST only; never import tests or bridge runtime."""
import ast
import json
import os
import pathlib
import sys


def inspect_source(source, filename):
    errors = []
    count = 0
    try:
        tree = ast.parse(source, filename=filename)
    except SyntaxError as error:
        return 0, [dict(kind='syntax-error', file=filename, line=error.lineno)]

    def scope(node, prefix=''):
        nonlocal count
        names = {}
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) and child.name.startswith('test_'):
                count += 1
                if child.name in names:
                    errors.append(dict(kind='duplicate-test', file=filename,
                                       name=prefix + child.name,
                                       firstLine=names[child.name], line=child.lineno))
                names[child.name] = child.lineno
            if isinstance(child, ast.ClassDef):
                scope(child, prefix + child.name + '.')
    scope(tree)
    return count, errors


def main(argv):
    checked, declared, errors = 0, 0, []
    if argv[:1] == ['--stdin']:
        count, errors = inspect_source(sys.stdin.read(), argv[1] if len(argv) > 1 else '<stdin>')
        checked, declared = 1, count
    else:
        root = pathlib.Path(argv[0] if argv else 'tests')
        if not root.is_dir():
            errors.append(dict(kind='read-error', file=str(root), code='NOT_DIRECTORY'))
        else:
            try:
                files = []
                def walk_error(error):
                    errors.append(dict(kind='read-error', file=str(error.filename), code=error.errno))
                for directory, _, names in os.walk(root, onerror=walk_error):
                    files.extend(pathlib.Path(directory) / name for name in names
                                 if name.startswith('test_') and name.endswith('.py'))
                files.sort()
                if not files:
                    errors.append(dict(kind='no-tests', file=str(root)))
                for file in files:
                    try:
                        count, found = inspect_source(file.read_text(encoding='utf-8-sig'), file.as_posix())
                        checked += 1
                        declared += count
                        errors.extend(found)
                    except (OSError, UnicodeError) as error:
                        errors.append(dict(kind='read-error', file=file.as_posix(), code=type(error).__name__))
            except OSError as error:
                errors.append(dict(kind='read-error', file=str(root), code=type(error).__name__))
    print(json.dumps(dict(checkedFiles=checked, declaredTests=declared,
                          executionVerified=False, errors=errors), ensure_ascii=True))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
