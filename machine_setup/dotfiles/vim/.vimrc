
syntax on

" set space as leader key
nnoremap <SPACE> <Nop>
let mapleader=" "

set number
set relativenumber
" highlight line cursor is currently on
set cursorline
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

" navigate open splits
nnoremap <leader>h <C-w>h
nnoremap <leader>j <C-w>j
nnoremap <leader>k <C-w>k
nnoremap <leader>l <C-w>l
" nav tabs by tabbing
nnoremap <TAB> :bn<CR>
nnoremap <S-TAB> :bp<CR>
" shortcuts to split
nnoremap <leader>- :split<CR>
nnoremap <leader>= :vsplit<CR>
" close current buffer
nnoremap <leader>q :bd<CR>

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

""" airline configurations
let g:airline#extensions#tabline#enabled = 1

""" NERDTree configurations
" toggle NERDTree show
nnoremap <leader>t :NERDTreeToggle<CR>
" to show hidden files in NERDTree plugin
let NERDTreeShowHidden = 1
" Exit Vim if NERDTree is the only window remaining in the only tab.
autocmd BufEnter * if tabpagenr('$') == 1 && winnr('$') == 1 && exists('b:NERDTree') && b:NERDTree.isTabTree() | call feedkeys(":quit\<CR>:\<BS>") | endif


