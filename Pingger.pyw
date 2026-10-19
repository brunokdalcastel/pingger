# Duplo-clique abre o Pingger sem janela de console.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pingger.__main__ import main

sys.exit(main(sys.argv[1:]))
