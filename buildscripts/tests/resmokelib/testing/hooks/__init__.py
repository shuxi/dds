"""Test package for resmokelib hooks.

On Python 2.7, `unittest` resolves dotted names by importing the parent module and then
`getattr()`-walking the remaining components. Ensure the test modules are importable as
attributes of this package.
"""

from . import test_combine_benchrun_embedded_results  # noqa: F401
