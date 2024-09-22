
syntax on

set number
set relativenumber
" highlight line cursor is currently on
" set cursorline
" hi CursorLine cterm=bold 
" enable mouse mode
set mouse=a
" set highlight on search
set hlsearch
" line padding between cursor and top/bottom of file
set scrolloff=5
" share vim and system clipboard
set clipboard+=unnamedplus
" set showmode=false
" case insensitive searching unless \C or one or more capital letters in
" search
set ignorecase
set smartcase
" saved undo history
" set undofile
" change cursor on insert mode
let &t_SI = "\<Esc>]50;CursorShape=1\x7"
let &t_SR = "\<Esc>]50;CursorShape=2\x7"
let &t_EI = "\<Esc>]50;CursorShape=0\x7"
set ttimeout
set ttimeoutlen=1
set ttyfast
" config to enable theme
set termguicolors

filetype plugin indent on

" <<<<<<<< start plugins
call plug#begin()

" pastel theme
Plug 'catppuccin/vim', { 'as': 'catppuccin' }
" vim status bar
Plug 'vim-airline/vim-airline'
" file tree
Plug 'preservim/nerdtree'

call plug#end()
" end plugins >>>>>>>>

colorscheme catppuccin_mocha

" to show hidden files in NERDTree plugin
let NERDTreeShowHidden=1


