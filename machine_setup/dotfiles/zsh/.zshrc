if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

export ZSH="$HOME/.oh-my-zsh"

# Standard plugins can be found in $ZSH/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
plugins=(git)

# include(): source if exists
include () {
	[[ -f "$1" ]] && source "$1"
}
source $ZSH/oh-my-zsh.sh
include $HOME/.shell_profiles/.barrel
include $HOME/.shell_profiles/.env

# alias for starting kanata with config with custom key mappings
alias kanata="sudo ~/.cargo/bin/kanata -c ~/.config/kanata/config.kbd"

# p10k theme, must be at end of .zshrc
source ~/powerlevel10k/powerlevel10k.zsh-theme
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh
